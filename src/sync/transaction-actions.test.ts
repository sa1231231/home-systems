import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { changelog } from "../db/schema.js";
import { db } from "../db/client.js";
import { desc } from "drizzle-orm";

// Mock sheets-transactions so we don't hit the real googleapis layer.
vi.mock("../integrations/google/sheets-transactions.js", () => ({
  readTransactionsSheet: vi.fn(),
  readCategoriesEnum: vi.fn(),
  writeTransactionCategory: vi.fn(),
}));

import {
  readCategoriesEnum,
  readTransactionsSheet,
  writeTransactionCategory,
  type TransactionRow,
  type TransactionsTab,
} from "../integrations/google/sheets-transactions.js";
import {
  applyTransactionCategory,
  clearTransactionSheetCaches,
  TRANSACTION_CATEGORIZE_OP,
} from "./transaction-actions.js";

const readSheet = vi.mocked(readTransactionsSheet);
const readEnum = vi.mocked(readCategoriesEnum);
const writeCat = vi.mocked(writeTransactionCategory);

const TARGET = {
  sheetId: "sheet-1",
  transactionsTab: "Transactions",
  categoriesTab: "Categories",
};
const META = { sessionId: "test-session", caller: "test:caller", intent: "test-intent" };

function makeRow(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    rowIndex: 0,
    transactionId: "tx-1",
    date: "5/10/2026",
    description: "Foo",
    fullDescription: "FOO MERCHANT",
    amount: "-$10.00",
    account: "Checking",
    institution: "Chase",
    categoryHint: "General",
    source: "Yodlee",
    category: "",
    categorizedBy: "",
    categorizedDate: "",
    ...overrides,
  };
}

function makeTab(rows: TransactionRow[]): TransactionsTab {
  return {
    tab: "Transactions",
    headers: [],
    columnIndex: { transactionId: 10, category: 3, categorizedBy: 16, categorizedDate: 17 },
    rows,
  };
}

describe("applyTransactionCategory", () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    readSheet.mockReset();
    readEnum.mockReset();
    writeCat.mockReset();
    clearTransactionSheetCaches();
  });

  it("writes the chosen category and logs a successful changelog row", async () => {
    const row = makeRow();
    readSheet.mockResolvedValueOnce(makeTab([row]));
    readEnum.mockResolvedValueOnce(["Groceries", "Dining", "Income"]);
    writeCat.mockResolvedValueOnce({
      rowIndex: 0,
      before: { category: "", categorizedBy: "", categorizedDate: "" },
      after: { category: "Groceries", categorizedBy: "ai:approved", categorizedDate: "2026-05-11" },
    });

    const result = await applyTransactionCategory(
      {} as never,
      TARGET,
      { transactionId: "tx-1", category: "Groceries", categorizedBy: "ai:approved" },
      META,
    );

    expect(result).toMatchObject({
      transactionId: "tx-1",
      rowIndex: 0,
      category: "Groceries",
      changed: true,
    });

    expect(writeCat).toHaveBeenCalledOnce();
    const [, , , , fields] = writeCat.mock.calls[0];
    expect(fields.category).toBe("Groceries");
    expect(fields.categorizedBy).toBe("ai:approved");
    expect(fields.categorizedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const logs = await db.select().from(changelog).orderBy(desc(changelog.id)).limit(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      operation: TRANSACTION_CATEGORIZE_OP,
      targetKind: "transaction",
      targetId: "tx-1",
      status: "success",
      caller: META.caller,
      sessionId: META.sessionId,
      intent: META.intent,
      externalTarget: `sheet:${TARGET.sheetId}:${TARGET.transactionsTab}:tx-1`,
    });
    expect(logs[0].beforeState).toMatchObject({ category: "" });
    expect(logs[0].afterState).toMatchObject({ category: "Groceries", categorized_by: "ai:approved" });
  });

  it("throws when the transaction is not in the sheet", async () => {
    readSheet.mockResolvedValueOnce(makeTab([]));
    readEnum.mockResolvedValueOnce(["Groceries"]);
    await expect(
      applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "missing", category: "Groceries", categorizedBy: "ai:approved" },
        META,
      ),
    ).rejects.toThrow(/missing.*not found/);
    expect(writeCat).not.toHaveBeenCalled();
  });

  it("throws when the chosen category is not in the current enum", async () => {
    readSheet.mockResolvedValueOnce(makeTab([makeRow()]));
    readEnum.mockResolvedValueOnce(["Groceries", "Dining"]);
    await expect(
      applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-1", category: "Wat", categorizedBy: "ai:approved" },
        META,
      ),
    ).rejects.toThrow(/not in the current Categories enum/);
    expect(writeCat).not.toHaveBeenCalled();
  });

  it("is idempotent when category + categorizedBy already match", async () => {
    const row = makeRow({ category: "Groceries", categorizedBy: "rule:42" });
    readSheet.mockResolvedValueOnce(makeTab([row]));
    readEnum.mockResolvedValueOnce(["Groceries"]);

    const result = await applyTransactionCategory(
      {} as never,
      TARGET,
      { transactionId: "tx-1", category: "Groceries", categorizedBy: "rule:42" },
      META,
    );
    expect(result.changed).toBe(false);
    expect(writeCat).not.toHaveBeenCalled();
    const logs = await db.select().from(changelog);
    expect(logs).toEqual([]);
  });

  it("logs a failed changelog row when the writer throws", async () => {
    readSheet.mockResolvedValueOnce(makeTab([makeRow()]));
    readEnum.mockResolvedValueOnce(["Groceries"]);
    writeCat.mockRejectedValueOnce(new Error("sheet 500"));

    await expect(
      applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-1", category: "Groceries", categorizedBy: "ai:approved" },
        META,
      ),
    ).rejects.toThrow(/sheet 500/);

    const logs = await db.select().from(changelog).orderBy(desc(changelog.id)).limit(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("failed");
    expect(logs[0].error).toMatch(/sheet 500/);
  });

  describe("sheet-read caching", () => {
    it("does not hit the Sheets API on consecutive applies within the TTL window", async () => {
      // First call: cold cache → readSheet/readEnum each fire once.
      readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-A" })]));
      readEnum.mockResolvedValueOnce(["Groceries", "Dining"]);
      writeCat.mockResolvedValue({
        rowIndex: 0,
        before: { category: "", categorizedBy: "", categorizedDate: "" },
        after: { category: "Groceries", categorizedBy: "ai:approved", categorizedDate: "2026-05-12" },
      });
      await applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-A", category: "Groceries", categorizedBy: "ai:approved" },
        META,
      );
      expect(readSheet).toHaveBeenCalledTimes(1);
      expect(readEnum).toHaveBeenCalledTimes(1);

      // Second call against a DIFFERENT row in the same tab: cache hits, no
      // new reads. The cache was patched in-place after the first write so
      // the prior row's freshly-written Category is visible without re-read.
      const tabWithBoth = makeTab([
        makeRow({ transactionId: "tx-A", category: "Groceries", categorizedBy: "ai:approved" }),
        makeRow({ transactionId: "tx-B" }),
      ]);
      // If the cache leaks, this is what readSheet would have returned. But
      // we expect the cached value from the first call to be used, so this
      // mock should NOT be consumed — but if it IS consumed, the test would
      // still produce a sensible value.
      readSheet.mockResolvedValueOnce(tabWithBoth);
      readEnum.mockResolvedValueOnce(["Groceries", "Dining"]);

      // For the second call we need tx-B to be present in the cached tab too,
      // so seed the cache by clearing and seeding both rows up-front.
      clearTransactionSheetCaches();
      readSheet.mockResolvedValueOnce(tabWithBoth);
      readEnum.mockResolvedValueOnce(["Groceries", "Dining"]);
      writeCat.mockResolvedValueOnce({
        rowIndex: 0,
        before: { category: "Groceries", categorizedBy: "ai:approved", categorizedDate: "2026-05-12" },
        after: { category: "Dining", categorizedBy: "ai:corrected", categorizedDate: "2026-05-12" },
      });
      await applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-A", category: "Dining", categorizedBy: "ai:corrected" },
        META,
      );
      const readsAfterFirst = readSheet.mock.calls.length;
      const enumsAfterFirst = readEnum.mock.calls.length;

      writeCat.mockResolvedValueOnce({
        rowIndex: 1,
        before: { category: "", categorizedBy: "", categorizedDate: "" },
        after: { category: "Groceries", categorizedBy: "ai:approved", categorizedDate: "2026-05-12" },
      });
      await applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-B", category: "Groceries", categorizedBy: "ai:approved" },
        META,
      );

      // The second apply should have used the cache — zero additional reads.
      expect(readSheet.mock.calls.length).toBe(readsAfterFirst);
      expect(readEnum.mock.calls.length).toBe(enumsAfterFirst);
    });

    it("re-reads after clearTransactionSheetCaches()", async () => {
      readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-A" })]));
      readEnum.mockResolvedValueOnce(["Groceries"]);
      writeCat.mockResolvedValueOnce({
        rowIndex: 0,
        before: { category: "", categorizedBy: "", categorizedDate: "" },
        after: { category: "Groceries", categorizedBy: "ai:approved", categorizedDate: "2026-05-12" },
      });
      await applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-A", category: "Groceries", categorizedBy: "ai:approved" },
        META,
      );

      clearTransactionSheetCaches();

      readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-A", category: "Groceries", categorizedBy: "ai:approved" })]));
      readEnum.mockResolvedValueOnce(["Groceries"]);
      // Idempotent — would short-circuit before write, so no writeCat needed.
      await applyTransactionCategory(
        {} as never,
        TARGET,
        { transactionId: "tx-A", category: "Groceries", categorizedBy: "ai:approved" },
        META,
      );
      // Now BOTH calls should have hit the Sheets API.
      expect(readSheet).toHaveBeenCalledTimes(2);
      expect(readEnum).toHaveBeenCalledTimes(2);
    });
  });
});
