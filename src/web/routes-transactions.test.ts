import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { needsReview, rules, triageRuns } from "../db/schema.js";

vi.mock("../sync/transaction-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/transaction-triage.js")>(
    "../sync/transaction-triage.js",
  );
  return { ...actual, triageTransactions: vi.fn(), applyRuleToSheet: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return { ...actual, hasGoogleCreds: vi.fn(), getOAuthClient: vi.fn() };
});
vi.mock("../integrations/google/sheets-transactions.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/sheets-transactions.js")>(
    "../integrations/google/sheets-transactions.js",
  );
  return { ...actual, readCategoriesEnum: vi.fn() };
});

import { applyRuleToSheet, triageTransactions } from "../sync/transaction-triage.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readCategoriesEnum } from "../integrations/google/sheets-transactions.js";
import { containsMerchantMatch } from "../sync/transaction-rules.js";
import { makeTransactionsUiRouter } from "./routes-transactions.js";

const triageMock = vi.mocked(triageTransactions);
const applyRuleMock = vi.mocked(applyRuleToSheet);
const hasCredsMock = vi.mocked(hasGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);
const readEnumMock = vi.mocked(readCategoriesEnum);

function buildApp(opts: { sheetId?: string } = {}) {
  const app = makeTestApp();
  mountViews(app);
  app.use(
    "/ui/transactions",
    makeTransactionsUiRouter({
      sheetId: opts.sheetId,
      transactionsTab: "Transactions",
      categoriesTab: "Categories",
    }),
  );
  return app;
}

describe("routes-transactions", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    triageMock.mockReset();
    applyRuleMock.mockReset();
    hasCredsMock.mockReset();
    oauthMock.mockReset();
    readEnumMock.mockReset();
  });

  describe("GET /ui/transactions", () => {
    it("renders a warning banner when TRANSACTIONS_SHEET_ID is not configured", async () => {
      const res = await request(buildApp({ sheetId: undefined })).get("/ui/transactions/");
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/TRANSACTIONS_SHEET_ID is not configured/);
      // No sheetId → no "Open sheet" link.
      expect(res.text).not.toMatch(/Open sheet/);
    });

    it("renders an 'Open sheet' link to docs.google.com when sheetId is configured", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      readEnumMock.mockResolvedValueOnce(["X"]);
      const res = await request(buildApp({ sheetId: "abc123" })).get("/ui/transactions/");
      expect(res.text).toMatch(/Open sheet/);
      expect(res.text).toContain(
        `href="https://docs.google.com/spreadsheets/d/abc123/edit"`,
      );
      expect(res.text).toContain(`target="_blank"`);
      expect(res.text).toContain(`rel="noopener noreferrer"`);
    });

    it("renders a warning banner when google creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp({ sheetId: "sheet" })).get("/ui/transactions/");
      expect(res.text).toMatch(/Google credentials/);
    });

    it("renders categories pulled from the Categories tab when creds are present", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      readEnumMock.mockResolvedValueOnce(["Groceries", "Dining", "Rent"]);
      const res = await request(buildApp({ sheetId: "sheet" })).get("/ui/transactions/");
      expect(res.text).toMatch(/Canonical categories: 3/);
    });

    it("renders an error banner when readCategoriesEnum throws", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      readEnumMock.mockRejectedValueOnce(new Error("sheet 404"));
      const res = await request(buildApp({ sheetId: "sheet" })).get("/ui/transactions/");
      expect(res.text).toMatch(/Failed to read Categories/);
      expect(res.text).toMatch(/sheet 404/);
    });

    it("includes pending transaction reviews", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      readEnumMock.mockResolvedValueOnce(["X"]);
      await db.insert(needsReview).values({
        domain: "transaction",
        subject: { description: "MARKER MERCHANT", amount: "-$5" } as never,
        subjectKind: "transaction",
        subjectId: "tx-marker",
        proposedAction: { category: "X", reasoning: "ok" } as never,
        status: "pending",
      });
      const res = await request(buildApp({ sheetId: "sheet" })).get("/ui/transactions/");
      expect(res.text).toContain("MARKER MERCHANT");
    });
  });

  describe("POST /ui/transactions/triage", () => {
    it("returns 503 when sheetId is not configured", async () => {
      const res = await request(buildApp({ sheetId: undefined })).post("/ui/transactions/triage");
      expect(res.status).toBe(503);
      expect(triageMock).not.toHaveBeenCalled();
    });

    it("returns 503 when google creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp({ sheetId: "sheet" })).post("/ui/transactions/triage");
      expect(res.status).toBe(503);
    });

    it("runs triage with the configured target and returns HX-Refresh", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      triageMock.mockResolvedValueOnce({
        total: 3,
        matched: 1,
        queued: 1,
        skipped: 1,
        errors: 0,
        items: [],
      });
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post("/ui/transactions/triage")
        .type("form")
        .send({ limit: "3" });
      expect(res.status).toBe(200);
      expect(res.headers["hx-refresh"]).toBe("true");
      expect(res.text).toMatch(/matched=1/);

      const opts = triageMock.mock.calls[0][1];
      expect(opts.limit).toBe(3);
      expect(opts.target).toEqual({
        sheetId: "sheet",
        transactionsTab: "Transactions",
        categoriesTab: "Categories",
      });
      expect(opts.caller).toBe("ui:transactions.triage");
    });

    it("returns a 500 banner when triage throws", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      triageMock.mockRejectedValueOnce(new Error("triage broke"));
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post("/ui/transactions/triage")
        .type("form")
        .send({ limit: "5" });
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/triage broke/);
    });

    it("returns 503 with an actionable banner when ANTHROPIC_API_KEY is missing", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      const { MissingAnthropicKeyError } = await import("../ai/index.js");
      triageMock.mockRejectedValueOnce(new MissingAnthropicKeyError());
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post("/ui/transactions/triage")
        .type("form")
        .send({ limit: "5" });
      expect(res.status).toBe(503);
      expect(res.text).toMatch(/ANTHROPIC_API_KEY/);
      expect(res.text).toMatch(/Railway/);
    });
  });

  describe("GET /ui/transactions/triage-status", () => {
    it("renders an empty status div when no recent runs exist", async () => {
      const res = await request(buildApp({ sheetId: "sheet" })).get(
        "/ui/transactions/triage-status",
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain('id="triage-status"');
      expect(res.text).not.toMatch(/running/i);
    });

    it("renders the running banner when a run is in-flight", async () => {
      await db.insert(triageRuns).values({
        domain: "transaction",
        sessionId: "s",
        caller: "ui:transactions.triage",
        status: "running",
      });
      const res = await request(buildApp({ sheetId: "sheet" })).get(
        "/ui/transactions/triage-status",
      );
      expect(res.text).toMatch(/Triage running/);
      expect(res.text).toMatch(/hx-trigger="every 3s"/);
      expect(res.text).toContain("/ui/transactions/triage-status?polling=1");
    });

    it("sends HX-Refresh when polling and the latest run just completed", async () => {
      await db.insert(triageRuns).values({
        domain: "transaction",
        sessionId: "s",
        caller: "ui:transactions.triage",
        status: "success",
        completedAt: new Date(),
        summary: { total: 1 } as never,
      });
      const res = await request(buildApp({ sheetId: "sheet" }))
        .get("/ui/transactions/triage-status?polling=1");
      expect(res.headers["hx-refresh"]).toBe("true");
      expect(res.text).toBe("");
    });

    it("does NOT send HX-Refresh on direct page visit (no polling=1)", async () => {
      await db.insert(triageRuns).values({
        domain: "transaction",
        sessionId: "s",
        caller: "ui:transactions.triage",
        status: "success",
        completedAt: new Date(),
        summary: { total: 1 } as never,
      });
      const res = await request(buildApp({ sheetId: "sheet" })).get(
        "/ui/transactions/triage-status",
      );
      expect(res.headers["hx-refresh"]).toBeUndefined();
      // Should render the "fresh" success banner instead.
      expect(res.text).toMatch(/Last run finished/);
    });

    it("ignores runs from other domains", async () => {
      await db.insert(triageRuns).values({
        domain: "email",
        sessionId: "s",
        caller: "ui:gmail.triage",
        status: "running",
      });
      const res = await request(buildApp({ sheetId: "sheet" })).get(
        "/ui/transactions/triage-status",
      );
      expect(res.text).not.toMatch(/Triage running/);
    });
  });

  async function insertTransactionReview(category = "Shopping") {
    const [row] = await db
      .insert(needsReview)
      .values({
        domain: "transaction",
        subject: { description: "Amazon Order", full_description: "AMZN MKTP*1A2B" } as never,
        subjectKind: "transaction",
        subjectId: `tx-${Math.random().toString(36).slice(2, 8)}`,
        proposedAction: { category, reasoning: "ai" } as never,
        status: "pending",
      })
      .returning();
    return row;
  }

  describe("POST /ui/transactions/review/:id/decide", () => {
    it("promotes an exact rule for rule_scope=exact", async () => {
      const entry = await insertTransactionReview("Shopping");
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "exact" });
      expect(res.status).toBe(200);
      const rs = await db.select().from(rules);
      expect(rs).toHaveLength(1);
      expect(rs[0].match).toEqual({
        op: "equals",
        field: "full_description",
        value: "AMZN MKTP*1A2B",
      });
    });

    it("promotes one contains rule for rule_scope=contains", async () => {
      const entry = await insertTransactionReview("Shopping");
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "contains", rule_value: "amazon" });
      expect(res.status).toBe(200);
      const rs = await db.select().from(rules);
      expect(rs).toHaveLength(1);
      expect(rs[0].match).toEqual(containsMerchantMatch("amazon"));
    });

    it("saves no rule for rule_scope=once", async () => {
      const entry = await insertTransactionReview("Shopping");
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "once" });
      expect(res.status).toBe(200);
      expect(await db.select().from(rules)).toHaveLength(0);
    });

    it("registers a situational merchant for rule_scope=situational", async () => {
      const entry = await insertTransactionReview("Shopping");
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "situational", rule_value: "amazon" });
      expect(res.status).toBe(200);
      const rs = await db.select().from(rules);
      expect(rs).toHaveLength(1);
      expect(rs[0].action).toEqual({ situational: true });
    });

    it("rejects contains without a merchant token", async () => {
      const entry = await insertTransactionReview("Shopping");
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "contains" });
      expect(res.status).toBe(400);
      expect(await db.select().from(rules)).toHaveLength(0);
    });

    it("promotes a card-wide account rule for rule_scope=account", async () => {
      const [entry] = await db
        .insert(needsReview)
        .values({
          domain: "transaction",
          subject: {
            description: "Some Shop",
            full_description: "SOME SHOP",
            account: "Chase Sapphire",
          } as never,
          subjectKind: "transaction",
          subjectId: "tx-acct",
          proposedAction: { category: "Shopping", reasoning: "ai" } as never,
          status: "pending",
        })
        .returning();
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "account" });
      expect(res.status).toBe(200);
      const rs = await db.select().from(rules);
      expect(rs).toHaveLength(1);
      expect(rs[0].match).toEqual({ op: "equals", field: "account", value: "Chase Sapphire" });
      // Catch-all rules sit below merchant rules in priority.
      expect(rs[0].priority).toBe(200);
    });

    it("rejects rule_scope=account when the transaction has no account", async () => {
      const entry = await insertTransactionReview("Shopping");
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post(`/ui/transactions/review/${entry.id}/decide`)
        .type("form")
        .send({ category: "Shopping", rule_scope: "account" });
      expect(res.status).toBe(400);
      expect(await db.select().from(rules)).toHaveLength(0);
    });
  });

  describe("POST /ui/transactions/situational", () => {
    it("adds a situational merchant rule and signals a refresh", async () => {
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post("/ui/transactions/situational")
        .type("form")
        .send({ value: "amazon" });
      expect(res.status).toBe(200);
      expect(res.headers["hx-refresh"]).toBe("true");
      const rs = await db.select().from(rules);
      expect(rs).toHaveLength(1);
      expect(rs[0].action).toEqual({ situational: true });
    });
  });

  describe("POST /ui/transactions/rules/:id/apply", () => {
    it("applies a rule to the sheet and returns a banner", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      const [rule] = await db
        .insert(rules)
        .values({
          domain: "transaction",
          name: "r",
          match: { op: "equals", field: "full_description", value: "X" } as never,
          action: { category: "Y" } as never,
          createdBy: "manual",
        })
        .returning();
      applyRuleMock.mockResolvedValueOnce({
        ruleId: rule.id,
        applied: 4,
        errors: 0,
        errorDetails: [],
      });
      const res = await request(buildApp({ sheetId: "sheet" })).post(
        `/ui/transactions/rules/${rule.id}/apply`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/categorized 4/);
      expect(applyRuleMock).toHaveBeenCalledOnce();
    });

    it("returns 404 for an unknown rule", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      const res = await request(buildApp({ sheetId: "sheet" })).post(
        "/ui/transactions/rules/99999/apply",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /ui/transactions/cleanup/consolidate", () => {
    it("consolidates exact rules into one contains rule", async () => {
      hasCredsMock.mockReturnValue(false); // skip the retroactive-apply step
      const inserted = await db
        .insert(rules)
        .values([
          {
            domain: "transaction",
            name: "auto: AMZN 1",
            match: { op: "equals", field: "full_description", value: "AMZN 1" } as never,
            action: { category: "Shopping" } as never,
            createdBy: "bootstrap",
          },
          {
            domain: "transaction",
            name: "auto: AMZN 2",
            match: { op: "equals", field: "full_description", value: "AMZN 2" } as never,
            action: { category: "Shopping" } as never,
            createdBy: "bootstrap",
          },
        ])
        .returning();
      const res = await request(buildApp({ sheetId: "sheet" }))
        .post("/ui/transactions/cleanup/consolidate")
        .type("form")
        .send({
          token: "amzn",
          category: "Shopping",
          ruleIds: inserted.map((r) => r.id).join(","),
        });
      expect(res.status).toBe(200);
      expect(res.headers["hx-refresh"]).toBe("true");
      const rs = await db.select().from(rules);
      expect(rs).toHaveLength(1);
      expect(rs[0].match).toEqual(containsMerchantMatch("amzn"));
    });
  });
});
