import type { TransactionRow } from "../integrations/google/sheets-transactions.js";

export type CategorySpend = { category: string; total: number };
export type MonthCashflow = { month: string; income: number; expense: number; net: number };
export type MonthSpend = { month: string; expense: number };
export type MerchantSpend = { merchant: string; total: number; count: number };

export type TransactionAnalytics = {
  /** "YYYY-MM" of the reference "now", or null when there are no rows. */
  currentMonth: string | null;
  /** Current-month spend per category (expenses only), largest first. */
  spendByCategory: CategorySpend[];
  /** Income vs expense per month over the window, chronological. */
  cashflowByMonth: MonthCashflow[];
  /** Expense per month over the window, chronological. */
  spendTrend: MonthSpend[];
  /** Current-month merchants by spend, largest first, capped. */
  topMerchants: MerchantSpend[];
  /** Rows with no category, across all months. */
  uncategorizedCount: number;
  /** Current-month income/expense/net. */
  monthlyTotals: { income: number; expense: number; net: number };
};

/**
 * Parse a sheet amount cell into a number. Handles currency symbols, thousands
 * separators, a leading minus, and accounting-style parentheses for negatives.
 * Returns null for blank or non-numeric cells.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.includes("-");
  const digits = s.replace(/[(),\s]/g, "").replace(/[^0-9.]/g, "");
  if (!digits || !/[0-9]/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Parse a date cell into a "YYYY-MM" month key. Supports ISO (YYYY-MM-DD) and
 * US (M/D/YYYY) formats, the two shapes Tiller sheets produce. Returns null for
 * anything else.
 */
export function parseMonthKey(dateRaw: string): string | null {
  const s = dateRaw.trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const month = Number(iso[2]);
    if (month >= 1 && month <= 12) return `${iso[1]}-${String(month).padStart(2, "0")}`;
    return null;
  }

  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const month = Number(us[1]);
    if (month >= 1 && month <= 12) return `${us[3]}-${String(month).padStart(2, "0")}`;
    return null;
  }

  return null;
}

function monthKeyOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sortedDesc<T>(items: T[], value: (item: T) => number): T[] {
  return [...items].sort((a, b) => value(b) - value(a));
}

export function buildTransactionAnalytics(
  rows: TransactionRow[],
  opts: { now?: Date; months?: number; topMerchants?: number } = {},
): TransactionAnalytics {
  const now = opts.now ?? new Date();
  const monthsWindow = opts.months ?? 12;
  const merchantCap = opts.topMerchants ?? 8;
  const currentMonth = monthKeyOf(now);

  const categoryTotals = new Map<string, number>();
  const merchantTotals = new Map<string, { total: number; count: number }>();
  const cashflow = new Map<string, { income: number; expense: number }>();
  let uncategorizedCount = 0;
  let monthIncome = 0;
  let monthExpense = 0;

  for (const r of rows) {
    if (r.category.trim() === "") uncategorizedCount += 1;

    const amount = parseAmount(r.amount);
    const month = parseMonthKey(r.date);
    if (amount === null || month === null) continue;

    const income = amount > 0 ? amount : 0;
    const expense = amount < 0 ? -amount : 0;

    const cf = cashflow.get(month) ?? { income: 0, expense: 0 };
    cf.income += income;
    cf.expense += expense;
    cashflow.set(month, cf);

    if (month === currentMonth) {
      monthIncome += income;
      monthExpense += expense;
      if (expense > 0) {
        const cat = r.category.trim() || "Uncategorized";
        categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + expense);

        const merchant = (r.description.trim() || r.fullDescription.trim() || "Unknown").trim();
        const m = merchantTotals.get(merchant) ?? { total: 0, count: 0 };
        m.total += expense;
        m.count += 1;
        merchantTotals.set(merchant, m);
      }
    }
  }

  const spendByCategory = sortedDesc(
    [...categoryTotals.entries()].map(([category, total]) => ({ category, total })),
    (c) => c.total,
  );

  const topMerchants = sortedDesc(
    [...merchantTotals.entries()].map(([merchant, v]) => ({ merchant, ...v })),
    (m) => m.total,
  ).slice(0, merchantCap);

  const allMonths = [...cashflow.keys()].sort();
  const windowMonths = allMonths.slice(-monthsWindow);
  const cashflowByMonth: MonthCashflow[] = windowMonths.map((month) => {
    const cf = cashflow.get(month) ?? { income: 0, expense: 0 };
    return { month, income: cf.income, expense: cf.expense, net: cf.income - cf.expense };
  });
  const spendTrend: MonthSpend[] = cashflowByMonth.map((m) => ({
    month: m.month,
    expense: m.expense,
  }));

  return {
    currentMonth: rows.length === 0 ? null : currentMonth,
    spendByCategory,
    cashflowByMonth,
    spendTrend,
    topMerchants,
    uncategorizedCount,
    monthlyTotals: { income: monthIncome, expense: monthExpense, net: monthIncome - monthExpense },
  };
}
