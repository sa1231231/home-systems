import { describe, expect, it } from "vitest";
import {
  parseReviewDecisions,
  reviewProposalToRow,
  reviewedTransactionIds,
} from "./transaction-review-sheet.js";

describe("reviewProposalToRow", () => {
  it("serializes a pending review row", () => {
    expect(
      reviewProposalToRow({
        transactionId: "t1",
        date: "2026-11-05",
        description: "SQ *COFFEE",
        amount: "-4.50",
        aiCategory: "Dining",
        aiReasoning: "coffee shop",
      }),
    ).toEqual(["t1", "2026-11-05", "SQ *COFFEE", "-4.50", "Dining", "coffee shop", "", "pending"]);
  });
});

describe("parseReviewDecisions", () => {
  const header = [
    "Transaction ID",
    "Date",
    "Description",
    "Amount",
    "AI Category",
    "AI Reasoning",
    "Your Category",
    "Status",
  ];

  it("reads an override as a changed decision", () => {
    const out = parseReviewDecisions([
      header,
      ["t1", "2026-11-05", "X", "-5", "Dining", "why", "Groceries", "pending"],
    ]);
    expect(out).toEqual([
      { transactionId: "t1", category: "Groceries", aiCategory: "Dining", accepted: false, rowNumber: 2 },
    ]);
  });

  it("treats status done/approved with no override as accepting the AI category", () => {
    const out = parseReviewDecisions([
      header,
      ["t1", "", "X", "-5", "Dining", "why", "", "approved"],
      ["t2", "", "Y", "-6", "Rent", "why", "", "done"],
    ]);
    expect(out.map((d) => [d.transactionId, d.category, d.accepted])).toEqual([
      ["t1", "Dining", true],
      ["t2", "Rent", true],
    ]);
  });

  it("skips pending rows with no decision", () => {
    const out = parseReviewDecisions([
      header,
      ["t1", "", "X", "-5", "Dining", "why", "", "pending"],
    ]);
    expect(out).toEqual([]);
  });

  it("skips rows with no Transaction ID and no applicable category", () => {
    const out = parseReviewDecisions([
      header,
      ["", "", "X", "-5", "Dining", "why", "Food", "pending"],
      ["t2", "", "Y", "-6", "", "why", "", "approved"],
    ]);
    expect(out).toEqual([]);
  });

  it("counts an override equal to the AI category as accepted", () => {
    const out = parseReviewDecisions([header, ["t1", "", "X", "-5", "Dining", "", "Dining", ""]]);
    expect(out[0]).toMatchObject({ category: "Dining", accepted: true });
  });
});

describe("reviewedTransactionIds", () => {
  it("collects the ids already written to the tab", () => {
    const ids = reviewedTransactionIds([
      ["Transaction ID", "Status"],
      ["t1", "pending"],
      ["t2", "done"],
      ["", "pending"],
    ]);
    expect([...ids].sort()).toEqual(["t1", "t2"]);
  });

  it("is empty when the tab has no header/rows", () => {
    expect(reviewedTransactionIds([]).size).toBe(0);
  });
});
