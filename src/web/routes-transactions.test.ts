import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { rules, triageRuns } from "../db/schema.js";

vi.mock("../sync/transaction-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/transaction-triage.js")>(
    "../sync/transaction-triage.js",
  );
  return { ...actual, triageTransactions: vi.fn() };
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
  return { ...actual, readTransactionsSheet: vi.fn() };
});
vi.mock("../sync/transaction-autocat-migrate.js", () => ({
  migrateDbRulesToAutoCat: vi.fn(),
}));

import { triageTransactions } from "../sync/transaction-triage.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import {
  readTransactionsSheet,
} from "../integrations/google/sheets-transactions.js";
import { migrateDbRulesToAutoCat } from "../sync/transaction-autocat-migrate.js";
import { makeTransactionsUiRouter } from "./routes-transactions.js";

const migrateMock = vi.mocked(migrateDbRulesToAutoCat);

const triageMock = vi.mocked(triageTransactions);
const hasCredsMock = vi.mocked(hasGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);
const readTxnsMock = vi.mocked(readTransactionsSheet);

const emptyTab = {
  tab: "Transactions",
  headers: [],
  columnIndex: { transactionId: -1, category: -1, categorizedBy: -1, categorizedDate: -1 },
  rows: [],
};

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
    hasCredsMock.mockReset();
    oauthMock.mockReset();
    readTxnsMock.mockReset();
    // Dashboard read defaults to an empty tab; tests that care override it.
    readTxnsMock.mockResolvedValue(emptyTab);
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

    it("renders the analytics dashboard from the transactions tab", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      const now = new Date();
      const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-05`;
      readTxnsMock.mockResolvedValueOnce({
        ...emptyTab,
        rows: [
          {
            rowIndex: 0,
            transactionId: "t1",
            date: thisMonth,
            description: "Costco",
            fullDescription: "COSTCO WHSE",
            amount: "-120.00",
            account: "Checking",
            institution: "Bank",
            categoryHint: "",
            source: "",
            category: "Groceries",
            categorizedBy: "ai",
            categorizedDate: thisMonth,
          },
        ],
      });
      const res = await request(buildApp({ sheetId: "sheet" })).get("/ui/transactions/");
      expect(res.text).toContain('class="dash"');
      expect(res.text).toContain("Groceries");
      expect(res.text).toContain("Costco");
      expect(res.text).toContain("$120");
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
        applied: 0,
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
        autoCatTab: "AutoCat",
      });
      expect(opts.caller).toBe("ui:transactions.triage");
    });

    it("migrate-autocat runs the migration and returns a summary", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      migrateMock.mockResolvedValueOnce({
        appended: 3,
        skippedExisting: 1,
        skippedUnsupported: 0,
        tabMissing: false,
      });
      const res = await request(buildApp({ sheetId: "sheet" })).post(
        "/ui/transactions/migrate-autocat",
      );
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/3 rule\(s\) added/);
    });

    it("migrate-autocat 404s when the AutoCat tab is missing", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      migrateMock.mockResolvedValueOnce({
        appended: 0,
        skippedExisting: 0,
        skippedUnsupported: 0,
        tabMissing: true,
      });
      const res = await request(buildApp({ sheetId: "sheet" })).post(
        "/ui/transactions/migrate-autocat",
      );
      expect(res.status).toBe(404);
      expect(res.text).toMatch(/No "AutoCat" tab/);
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
        domain: "contact",
        sessionId: "s",
        caller: "ui:contacts.sync",
        status: "running",
      });
      const res = await request(buildApp({ sheetId: "sheet" })).get(
        "/ui/transactions/triage-status",
      );
      expect(res.text).not.toMatch(/Triage running/);
    });
  });

  describe("POST /ui/transactions/clear-db-rules", () => {
    it("deletes only transaction-domain rules and reports the count", async () => {
      await db.insert(rules).values([
        {
          domain: "transaction",
          name: "t1",
          match: { op: "equals", field: "full_description", value: "A" } as never,
          action: { category: "X" } as never,
          createdBy: "test",
        },
        {
          domain: "transaction",
          name: "t2",
          match: { op: "equals", field: "full_description", value: "B" } as never,
          action: { category: "Y" } as never,
          createdBy: "test",
        },
        {
          domain: "contact",
          name: "c1",
          match: { op: "present", field: "google_resource_name" } as never,
          action: { category: "z" } as never,
          createdBy: "test",
        },
      ]);
      const res = await request(buildApp({ sheetId: "sheet" })).post(
        "/ui/transactions/clear-db-rules",
      );
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/Cleared 2 migrated transaction rule/);
      const remaining = await db.select().from(rules);
      expect(remaining.map((r) => r.domain)).toEqual(["contact"]);
    });
  });

});
