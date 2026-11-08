import { describe, expect, it } from "vitest";
import type { TransactionRow } from "../integrations/google/sheets-transactions.js";
import {
  buildTransactionAnalytics,
  parseAmount,
  parseMonthKey,
} from "./transaction-analytics.js";

function row(partial: Partial<TransactionRow>): TransactionRow {
  return {
    rowIndex: 0,
    transactionId: Math.random().toString(36).slice(2),
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
    ...partial,
  };
}

describe("parseAmount", () => {
  it("parses plain and signed numbers", () => {
    expect(parseAmount("50")).toBe(50);
    expect(parseAmount("-50")).toBe(-50);
    expect(parseAmount("1234.56")).toBe(1234.56);
  });

  it("strips currency symbols and thousands separators", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount("-$1,234.56")).toBe(-1234.56);
    expect(parseAmount(" $12.00 ")).toBe(12);
  });

  it("treats parentheses as negative", () => {
    expect(parseAmount("($1,234.56)")).toBe(-1234.56);
    expect(parseAmount("(50)")).toBe(-50);
  });

  it("returns null for blank or non-numeric", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("  ")).toBeNull();
    expect(parseAmount("pending")).toBeNull();
  });
});

describe("parseMonthKey", () => {
  it("parses ISO dates", () => {
    expect(parseMonthKey("2026-11-08")).toBe("2026-11");
    expect(parseMonthKey("2026-01-01")).toBe("2026-01");
  });

  it("parses US M/D/YYYY dates", () => {
    expect(parseMonthKey("11/8/2026")).toBe("2026-11");
    expect(parseMonthKey("1/5/2026")).toBe("2026-01");
    expect(parseMonthKey("12/31/2025")).toBe("2025-12");
  });

  it("returns null for junk", () => {
    expect(parseMonthKey("")).toBeNull();
    expect(parseMonthKey("not-a-date")).toBeNull();
  });
});

describe("buildTransactionAnalytics", () => {
  const now = new Date("2026-11-15T12:00:00Z");

  it("sums current-month spend by category, largest first, expenses only", () => {
    const rows = [
      row({ date: "2026-11-02", amount: "-40", category: "Groceries" }),
      row({ date: "2026-11-09", amount: "-10", category: "Groceries" }),
      row({ date: "2026-11-05", amount: "-100", category: "Rent" }),
      row({ date: "2026-11-05", amount: "2000", category: "Income" }), // income excluded
      row({ date: "2026-10-30", amount: "-999", category: "Groceries" }), // prior month excluded
    ];
    const a = buildTransactionAnalytics(rows, { now });
    expect(a.currentMonth).toBe("2026-11");
    expect(a.spendByCategory).toEqual([
      { category: "Rent", total: 100 },
      { category: "Groceries", total: 50 },
    ]);
  });

  it("computes income vs expense and net per month, chronological", () => {
    const rows = [
      row({ date: "2026-10-01", amount: "3000", category: "Income" }),
      row({ date: "2026-10-15", amount: "-500", category: "Rent" }),
      row({ date: "2026-11-01", amount: "3000", category: "Income" }),
      row({ date: "2026-11-10", amount: "-200", category: "Food" }),
    ];
    const a = buildTransactionAnalytics(rows, { now });
    expect(a.cashflowByMonth).toEqual([
      { month: "2026-10", income: 3000, expense: 500, net: 2500 },
      { month: "2026-11", income: 3000, expense: 200, net: 2800 },
    ]);
    expect(a.spendTrend).toEqual([
      { month: "2026-10", expense: 500 },
      { month: "2026-11", expense: 200 },
    ]);
  });

  it("limits months to the requested window", () => {
    const rows = [
      row({ date: "2026-08-01", amount: "-10", category: "X" }),
      row({ date: "2026-09-01", amount: "-10", category: "X" }),
      row({ date: "2026-10-01", amount: "-10", category: "X" }),
      row({ date: "2026-11-01", amount: "-10", category: "X" }),
    ];
    const a = buildTransactionAnalytics(rows, { now, months: 2 });
    expect(a.cashflowByMonth.map((m) => m.month)).toEqual(["2026-10", "2026-11"]);
  });

  it("ranks top merchants for the current month and caps the list", () => {
    const rows = [
      row({ date: "2026-11-01", amount: "-30", description: "Amazon", category: "Shopping" }),
      row({ date: "2026-11-03", amount: "-20", description: "Amazon", category: "Shopping" }),
      row({ date: "2026-11-02", amount: "-100", description: "Costco", category: "Groceries" }),
      row({ date: "2026-11-04", amount: "-5", description: "Spotify", category: "Fun" }),
    ];
    const a = buildTransactionAnalytics(rows, { now, topMerchants: 2 });
    expect(a.topMerchants).toEqual([
      { merchant: "Costco", total: 100, count: 1 },
      { merchant: "Amazon", total: 50, count: 2 },
    ]);
  });

  it("falls back to full description when description is blank for a merchant", () => {
    const rows = [
      row({ date: "2026-11-01", amount: "-30", description: "", fullDescription: "SQ *COFFEE" }),
    ];
    const a = buildTransactionAnalytics(rows, { now });
    expect(a.topMerchants[0]).toMatchObject({ merchant: "SQ *COFFEE", total: 30 });
  });

  it("counts uncategorized rows across all months", () => {
    const rows = [
      row({ date: "2026-11-01", amount: "-30", category: "" }),
      row({ date: "2026-10-01", amount: "-30", category: "   " }),
      row({ date: "2026-11-01", amount: "-30", category: "Food" }),
    ];
    const a = buildTransactionAnalytics(rows, { now });
    expect(a.uncategorizedCount).toBe(2);
  });

  it("reports current-month totals", () => {
    const rows = [
      row({ date: "2026-11-01", amount: "5000", category: "Income" }),
      row({ date: "2026-11-02", amount: "-1200", category: "Rent" }),
      row({ date: "2026-11-03", amount: "-300", category: "Food" }),
    ];
    const a = buildTransactionAnalytics(rows, { now });
    expect(a.monthlyTotals).toEqual({ income: 5000, expense: 1500, net: 3500 });
  });

  it("is empty-safe", () => {
    const a = buildTransactionAnalytics([], { now });
    expect(a.spendByCategory).toEqual([]);
    expect(a.cashflowByMonth).toEqual([]);
    expect(a.topMerchants).toEqual([]);
    expect(a.uncategorizedCount).toBe(0);
    expect(a.monthlyTotals).toEqual({ income: 0, expense: 0, net: 0 });
  });
});
