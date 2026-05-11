import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseCategoriesValues,
  parseTransactionsValues,
  writeTransactionCategory,
  type RawSheetValues,
  type TransactionsTab,
} from "./sheets-transactions.js";

const FULL_HEADERS = [
  "",
  "Date",
  "Description",
  "Category",
  "Amount",
  "Account",
  "Account #",
  "Institution",
  "Month",
  "Week",
  "Transaction ID",
  "Account ID",
  "Check Number",
  "Full Description",
  "Date Added",
  "Category Hint",
  "Categorized By",
  "Categorized Date",
  "Source",
];

function rowOf(...vals: (string | number | null)[]): (string | number | null)[] {
  return vals;
}

describe("parseTransactionsValues", () => {
  it("returns empty shape for empty values", () => {
    const out = parseTransactionsValues([], "Transactions");
    expect(out).toEqual({
      tab: "Transactions",
      headers: [],
      columnIndex: { transactionId: -1, category: -1, categorizedBy: -1, categorizedDate: -1 },
      rows: [],
    });
  });

  it("parses a complete row with all optional columns", () => {
    const values: RawSheetValues = [
      FULL_HEADERS,
      rowOf(
        "",
        "5/10/2026",
        "Amazon Mktpl",
        "",
        "-$21.15",
        "CREDIT CARD",
        "xxxx9690",
        "Chase",
        "5/1/26",
        "5/10/26",
        "tx-abc",
        "acct-1",
        "",
        "AMAZON MKTPL FULL",
        "5/11/26",
        "Electronics",
        "",
        "",
        "Yodlee",
      ),
    ];
    const out = parseTransactionsValues(values, "Transactions");
    expect(out.headers).toEqual(FULL_HEADERS);
    expect(out.columnIndex).toEqual({
      transactionId: 10,
      category: 3,
      categorizedBy: 16,
      categorizedDate: 17,
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      rowIndex: 0,
      transactionId: "tx-abc",
      date: "5/10/2026",
      description: "Amazon Mktpl",
      amount: "-$21.15",
      account: "CREDIT CARD",
      institution: "Chase",
      categoryHint: "Electronics",
      fullDescription: "AMAZON MKTPL FULL",
      source: "Yodlee",
      category: "",
      categorizedBy: "",
      categorizedDate: "",
    });
  });

  it("preserves category + categorizedBy + categorizedDate values when populated", () => {
    const values: RawSheetValues = [
      FULL_HEADERS,
      rowOf(
        "",
        "5/10/2026",
        "Foo",
        "Groceries",
        "-$10.00",
        "",
        "",
        "",
        "",
        "",
        "tx-1",
        "",
        "",
        "FOO",
        "",
        "",
        "rule:42",
        "2026-05-10",
        "",
      ),
    ];
    const out = parseTransactionsValues(values, "T");
    expect(out.rows[0]).toMatchObject({
      category: "Groceries",
      categorizedBy: "rule:42",
      categorizedDate: "2026-05-10",
    });
  });

  it("trims headers and skips rows without a Transaction ID", () => {
    const headersWithSpaces = FULL_HEADERS.map((h) => `  ${h}  `);
    const values: RawSheetValues = [
      headersWithSpaces,
      // ID present
      rowOf("", "", "Foo", "", "", "", "", "", "", "", "tx-1", "", "", "", "", "", "", "", ""),
      // ID empty → skipped
      rowOf("", "", "Bar", "", "", "", "", "", "", "", "  ", "", "", "", "", "", "", "", ""),
      // ID present again, validates rowIndex continues advancing relative to sheet position
      rowOf("", "", "Baz", "", "", "", "", "", "", "", "tx-3", "", "", "", "", "", "", "", ""),
    ];
    const out = parseTransactionsValues(values, "T");
    expect(out.headers[10]).toBe("Transaction ID"); // trimmed
    expect(out.rows.map((r) => r.transactionId)).toEqual(["tx-1", "tx-3"]);
    expect(out.rows.map((r) => r.rowIndex)).toEqual([0, 2]);
  });

  it("throws when a required column is missing", () => {
    const headers = ["Date", "Description", "Transaction ID", "Categorized By", "Categorized Date"];
    expect(() => parseTransactionsValues([headers], "T")).toThrow(/Category/);
  });

  it("handles missing optional columns gracefully", () => {
    // Only required columns present.
    const headers = ["Transaction ID", "Category", "Categorized By", "Categorized Date"];
    const values: RawSheetValues = [headers, rowOf("tx-x", "", "", "")];
    const out = parseTransactionsValues(values, "T");
    expect(out.rows[0]).toMatchObject({
      transactionId: "tx-x",
      description: "",
      fullDescription: "",
      amount: "",
      account: "",
      institution: "",
      categoryHint: "",
      source: "",
    });
  });

  it("coerces non-string cell values to strings", () => {
    const headers = ["Transaction ID", "Category", "Categorized By", "Categorized Date", "Amount"];
    const values: RawSheetValues = [headers, rowOf(42, "", "", "", -21.15)];
    const out = parseTransactionsValues(values, "T");
    expect(out.rows[0].transactionId).toBe("42");
    expect(out.rows[0].amount).toBe("-21.15");
  });
});

describe("parseCategoriesValues", () => {
  it("returns ordered, deduped, non-empty categories", () => {
    const values: RawSheetValues = [
      ["Category", "Group", "Type"],
      ["Groceries", "Personal", "Expense"],
      ["Dining", "Personal", "Expense"],
      ["Groceries", "Personal", "Expense"], // duplicate
      ["  ", "Personal", "Expense"], // blank
      ["Income", "Income", "Income"],
    ];
    expect(parseCategoriesValues(values, "Categories")).toEqual([
      "Groceries",
      "Dining",
      "Income",
    ]);
  });

  it("throws on empty sheet", () => {
    expect(() => parseCategoriesValues([], "Categories")).toThrow(/empty/);
  });

  it("throws when Category column is missing", () => {
    expect(() =>
      parseCategoriesValues([["Group", "Type"], ["Personal", "Expense"]], "Categories"),
    ).toThrow(/Category/);
  });

  it("throws when no non-empty values", () => {
    expect(() =>
      parseCategoriesValues([["Category"], [""], ["   "]], "Categories"),
    ).toThrow(/no non-empty/);
  });

  it("trims whitespace from category values", () => {
    expect(
      parseCategoriesValues([["Category"], ["  Groceries  "], ["Dining"]], "Categories"),
    ).toEqual(["Groceries", "Dining"]);
  });
});

describe("writeTransactionCategory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("translates row + columnIndex into A1 ranges and snapshots before/after", async () => {
    const calls: { spreadsheetId: string; ranges: { range: string; value: string }[] }[] = [];
    vi.doMock("./sheets.js", async () => {
      const actual = await vi.importActual<typeof import("./sheets.js")>("./sheets.js");
      return {
        ...actual,
        batchUpdateCells: async (
          _client: unknown,
          spreadsheetId: string,
          ranges: { range: string; value: string }[],
        ) => {
          calls.push({ spreadsheetId, ranges });
        },
      };
    });

    const mod = await import("./sheets-transactions.js");
    const tab: TransactionsTab = {
      tab: "Transactions",
      headers: [],
      columnIndex: { transactionId: 10, category: 3, categorizedBy: 16, categorizedDate: 17 },
      rows: [],
    };
    const row = {
      rowIndex: 0, // first data row → sheet row 2
      transactionId: "tx-1",
      date: "",
      description: "",
      fullDescription: "",
      amount: "",
      account: "",
      institution: "",
      categoryHint: "",
      source: "",
      category: "",
      categorizedBy: "",
      categorizedDate: "",
    };
    const fields = {
      category: "Groceries",
      categorizedBy: "ai:approved",
      categorizedDate: "2026-05-11",
    };
    const snap = await mod.writeTransactionCategory(
      {} as never,
      "sheet-id",
      tab,
      row,
      fields,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].spreadsheetId).toBe("sheet-id");
    expect(calls[0].ranges).toEqual([
      { range: "Transactions!D2", value: "Groceries" },
      { range: "Transactions!Q2", value: "ai:approved" },
      { range: "Transactions!R2", value: "2026-05-11" },
    ]);
    expect(snap.before).toEqual({ category: "", categorizedBy: "", categorizedDate: "" });
    expect(snap.after).toEqual(fields);
    expect(snap.rowIndex).toBe(0);
  });

  it("preserves prior values in the before snapshot", async () => {
    vi.doMock("./sheets.js", async () => {
      const actual = await vi.importActual<typeof import("./sheets.js")>("./sheets.js");
      return { ...actual, batchUpdateCells: async () => {} };
    });
    const mod = await import("./sheets-transactions.js");
    const tab: TransactionsTab = {
      tab: "T",
      headers: [],
      columnIndex: { transactionId: 10, category: 3, categorizedBy: 16, categorizedDate: 17 },
      rows: [],
    };
    const row = {
      rowIndex: 4,
      transactionId: "tx-1",
      date: "",
      description: "",
      fullDescription: "",
      amount: "",
      account: "",
      institution: "",
      categoryHint: "",
      source: "",
      category: "OldCat",
      categorizedBy: "rule:7",
      categorizedDate: "2026-01-01",
    };
    const snap = await mod.writeTransactionCategory({} as never, "s", tab, row, {
      category: "NewCat",
      categorizedBy: "ai:corrected",
      categorizedDate: "2026-05-11",
    });
    expect(snap.before).toEqual({
      category: "OldCat",
      categorizedBy: "rule:7",
      categorizedDate: "2026-01-01",
    });
    expect(snap.rowIndex).toBe(4);
  });
});
