import type { RawValues } from "./transaction-rule-sheet.js";

/**
 * In-sheet review model. Low-confidence AI proposals are written to OUR OWN
 * "HS Review" tab (never Tiller's tabs — see the sheet-tabs invariant), keyed by
 * Transaction ID. The user reviews in the sheet by filling the "Your Category"
 * column; a sync reads those decisions back to apply the category and promote a
 * rule. This module is the pure (de)serialization layer — no Google calls.
 */

export const REVIEW_TAB_HEADERS = [
  "Transaction ID",
  "Date",
  "Description",
  "Amount",
  "AI Category",
  "AI Reasoning",
  "Your Category",
  "Status",
] as const;

export type ReviewProposal = {
  transactionId: string;
  date: string;
  description: string;
  amount: string;
  aiCategory: string;
  aiReasoning: string;
};

/** Serialize a proposal into a Review-tab row (status "pending"). */
export function reviewProposalToRow(p: ReviewProposal): (string | number)[] {
  return [
    p.transactionId,
    p.date,
    p.description,
    p.amount,
    p.aiCategory,
    p.aiReasoning,
    "", // Your Category — the user fills this to decide
    "pending",
  ];
}

export type ReviewDecision = {
  transactionId: string;
  /** The category the user settled on (their override, else the AI's). */
  category: string;
  aiCategory: string;
  /** True when the user kept the AI's category, false when they changed it. */
  accepted: boolean;
  rowNumber: number;
};

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

function cellStr(row: (string | number | boolean | null)[], i: number): string {
  if (i < 0) return "";
  const v = row[i];
  return v == null ? "" : String(v).trim();
}

/**
 * Read decided rows from the Review tab: a row counts as decided once "Your
 * Category" is filled, OR Status is "done"/"approved". Pending rows (no decision
 * yet) and rows missing a Transaction ID are skipped. The resulting category is
 * the user's override when present, otherwise the AI's category (an explicit
 * "approve as-is").
 */
export function parseReviewDecisions(values: RawValues): ReviewDecision[] {
  if (values.length < 1) return [];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const col = {
    id: headerIndex(headers, "Transaction ID"),
    aiCategory: headerIndex(headers, "AI Category"),
    yourCategory: headerIndex(headers, "Your Category"),
    status: headerIndex(headers, "Status"),
  };
  const out: ReviewDecision[] = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    const transactionId = cellStr(raw, col.id);
    if (!transactionId) continue;
    const aiCategory = cellStr(raw, col.aiCategory);
    const yourCategory = cellStr(raw, col.yourCategory);
    const status = cellStr(raw, col.status).toLowerCase();
    const decided = yourCategory !== "" || status === "done" || status === "approved";
    if (!decided) continue;
    const category = yourCategory || aiCategory;
    if (!category) continue; // approved with no AI category to fall back on — nothing to apply
    out.push({
      transactionId,
      category,
      aiCategory,
      accepted: yourCategory === "" || yourCategory === aiCategory,
      rowNumber: i + 1,
    });
  }
  return out;
}

/**
 * Transaction IDs already present in the Review tab, so triage doesn't write a
 * duplicate review row for the same transaction on a later run.
 */
export function reviewedTransactionIds(values: RawValues): Set<string> {
  const ids = new Set<string>();
  if (values.length < 1) return ids;
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const idCol = headerIndex(headers, "Transaction ID");
  if (idCol < 0) return ids;
  for (let i = 1; i < values.length; i++) {
    const id = cellStr(values[i] ?? [], idCol);
    if (id) ids.add(id);
  }
  return ids;
}
