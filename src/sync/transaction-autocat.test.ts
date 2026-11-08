import { describe, expect, it } from "vitest";
import {
  autoCatRuleKey,
  buildAutoCatRow,
  matchAutoCat,
  parseAutoCatRules,
} from "./transaction-autocat.js";

describe("parseAutoCatRules", () => {
  it("parses pure Description Contains -> Category rows", () => {
    const rules = parseAutoCatRules([
      ["Description Contains", "Category", "Note"],
      ["Costco", "Groceries", ""],
      ["Shell", "Gas", ""],
    ]);
    expect(rules).toEqual([
      { descriptionContains: "Costco", fullDescriptionContains: undefined, category: "Groceries", rowNumber: 2 },
      { descriptionContains: "Shell", fullDescriptionContains: undefined, category: "Gas", rowNumber: 3 },
    ]);
  });

  it("skips rows that use other filters (so we never half-apply)", () => {
    const rules = parseAutoCatRules([
      ["Description Contains", "Amount Min", "Category"],
      ["Transfer", "100", "Big Transfer"], // has an Amount Min filter → skip
      ["Costco", "", "Groceries"],
    ]);
    expect(rules.map((r) => r.category)).toEqual(["Groceries"]);
  });

  it("skips catch-all rows (Category with no contains filter)", () => {
    const rules = parseAutoCatRules([
      ["Description Contains", "Category"],
      ["", "Uncategorized"],
      ["Costco", "Groceries"],
    ]);
    expect(rules.map((r) => r.category)).toEqual(["Groceries"]);
  });

  it("returns nothing when there is no Category column", () => {
    expect(parseAutoCatRules([["Description Contains"], ["Costco"]])).toEqual([]);
  });
});

describe("matchAutoCat", () => {
  const rules = parseAutoCatRules([
    ["Description Contains", "Category"],
    ["Costco", "Groceries"],
    ["Shell", "Gas"],
  ]);

  it("matches case-insensitively on description", () => {
    expect(matchAutoCat(rules, { description: "COSTCO WHSE #42" })).toBe("Groceries");
    expect(matchAutoCat(rules, { description: "shell oil" })).toBe("Gas");
  });

  it("returns null when nothing matches", () => {
    expect(matchAutoCat(rules, { description: "Target" })).toBeNull();
  });

  it("ANDs description and full-description filters", () => {
    const r = parseAutoCatRules([
      ["Description Contains", "Full Description Contains", "Category"],
      ["sq", "coffee", "Dining"],
    ]);
    expect(matchAutoCat(r, { description: "SQ *X", full_description: "SQ COFFEE CO" })).toBe("Dining");
    expect(matchAutoCat(r, { description: "SQ *X", full_description: "SQ TACO" })).toBeNull();
  });
});

describe("buildAutoCatRow", () => {
  it("aligns values to the tab's header order", () => {
    const headers = ["Date", "Description Contains", "Category", "Note"];
    expect(buildAutoCatRow(headers, { descriptionContains: "Costco", category: "Groceries" })).toEqual([
      "",
      "Costco",
      "Groceries",
      "",
    ]);
  });

  it("throws when the required columns are missing", () => {
    expect(() => buildAutoCatRow(["Category"], { descriptionContains: "x", category: "Y" })).toThrow(
      /Description Contains/,
    );
    expect(() => buildAutoCatRow(["Description Contains"], { category: "Y" })).toThrow(/Category/);
  });
});

describe("autoCatRuleKey", () => {
  it("is case-insensitive and stable for dedupe", () => {
    expect(autoCatRuleKey({ descriptionContains: "Costco", category: "Groceries" })).toBe(
      autoCatRuleKey({ descriptionContains: "costco", category: "groceries" }),
    );
  });
});
