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
});
