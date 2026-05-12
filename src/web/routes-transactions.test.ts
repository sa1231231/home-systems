import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";

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
  return { ...actual, readCategoriesEnum: vi.fn() };
});

import { triageTransactions } from "../sync/transaction-triage.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readCategoriesEnum } from "../integrations/google/sheets-transactions.js";
import { makeTransactionsUiRouter } from "./routes-transactions.js";

const triageMock = vi.mocked(triageTransactions);
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
    hasCredsMock.mockReset();
    oauthMock.mockReset();
    readEnumMock.mockReset();
  });

  describe("GET /ui/transactions", () => {
    it("renders a warning banner when TRANSACTIONS_SHEET_ID is not configured", async () => {
      const res = await request(buildApp({ sheetId: undefined })).get("/ui/transactions/");
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/TRANSACTIONS_SHEET_ID is not configured/);
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
});
