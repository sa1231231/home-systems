import { describe, expect, it } from "vitest";
import {
  isSituationalAction,
  orderRules,
  parseRulesTabValues,
  parseSituationalTabValues,
  pickSheetMatch,
  ruleToSheetRow,
  type SheetRule,
} from "./transaction-rule-sheet.js";

const subject = (over: Record<string, string> = {}) => ({
  description: "",
  full_description: "",
  ...over,
});

describe("parseRulesTabValues", () => {
  it("parses contains rules with defaults", () => {
    const rows = parseRulesTabValues([
      ["Match", "Type", "Category", "Priority", "Enabled", "Notes"],
      ["Costco", "", "Groceries", "", "", "warehouse"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: { category: "Groceries" },
      priority: 100,
      enabled: true,
      rowNumber: 2,
    });
    // contains-match over both description fields
    expect(pickSheetMatch(rows, subject({ description: "COSTCO WHSE #42" }))).not.toBeNull();
  });

  it("honors equals type, explicit priority, and enabled flag", () => {
    const rows = parseRulesTabValues([
      ["Match", "Type", "Category", "Priority", "Enabled"],
      ["Rent Payment", "equals", "Rent", "50", "TRUE"],
      ["Old Gym", "contains", "Fitness", "100", "FALSE"],
    ]);
    expect(rows[0]).toMatchObject({ priority: 50, enabled: true });
    expect(rows[1]).toMatchObject({ enabled: false });
    // equals does not match a superstring
    expect(pickSheetMatch([rows[0]], subject({ description: "Rent Payment Extra" }))).toBeNull();
    expect(pickSheetMatch([rows[0]], subject({ description: "Rent Payment" }))).not.toBeNull();
  });

  it("skips rows missing match or category", () => {
    const rows = parseRulesTabValues([
      ["Match", "Category"],
      ["", "Groceries"],
      ["Costco", ""],
      ["Target", "Shopping"],
    ]);
    expect(rows.map((r) => (r.action as { category: string }).category)).toEqual(["Shopping"]);
  });

  it("treats a blank Enabled cell as enabled, explicit no as disabled", () => {
    const rows = parseRulesTabValues([
      ["Match", "Category", "Enabled"],
      ["A", "X", ""],
      ["B", "Y", "no"],
    ]);
    expect(rows[0].enabled).toBe(true);
    expect(rows[1].enabled).toBe(false);
  });

  it("falls back to the first column when there is no Match header", () => {
    const rows = parseRulesTabValues([
      ["Merchant", "Category"],
      ["Costco", "Groceries"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toEqual({ category: "Groceries" });
  });
});

describe("parseSituationalTabValues", () => {
  it("parses situational markers with priority 10", () => {
    const rows = parseSituationalTabValues([
      ["Merchant", "Notes"],
      ["Amazon", "varies"],
      ["", "skip"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ priority: 10, enabled: true, action: { situational: true } });
    expect(isSituationalAction(rows[0].action)).toBe(true);
  });
});

describe("pickSheetMatch / orderRules", () => {
  const rules: SheetRule[] = [
    ...parseSituationalTabValues([["Merchant"], ["Amazon"]]),
    ...parseRulesTabValues([
      ["Match", "Category", "Priority"],
      ["Amazon", "Shopping", "100"],
      ["Costco", "Groceries", "100"],
    ]),
  ];

  it("evaluates lower priority numbers first (situational before category)", () => {
    const ordered = orderRules(rules);
    expect(ordered[0].priority).toBe(10);
    const m = pickSheetMatch(rules, subject({ description: "AMAZON MKTP" }));
    expect(m?.action).toEqual({ situational: true });
  });

  it("matches a category rule when no situational marker applies", () => {
    const m = pickSheetMatch(rules, subject({ description: "COSTCO GAS" }));
    expect(m?.action).toEqual({ category: "Groceries" });
  });

  it("returns null when nothing matches", () => {
    expect(pickSheetMatch(rules, subject({ description: "RANDOM LLC" }))).toBeNull();
  });

  it("ignores disabled rules", () => {
    const disabled = parseRulesTabValues([
      ["Match", "Category", "Enabled"],
      ["Costco", "Groceries", "FALSE"],
    ]);
    expect(pickSheetMatch(disabled, subject({ description: "COSTCO" }))).toBeNull();
  });
});

describe("ruleToSheetRow", () => {
  it("serializes a rule row with defaults", () => {
    expect(ruleToSheetRow({ match: "Costco", category: "Groceries" })).toEqual([
      "Costco",
      "contains",
      "Groceries",
      100,
      "TRUE",
      "",
    ]);
  });
  it("serializes overrides", () => {
    expect(
      ruleToSheetRow({
        match: "Rent",
        type: "equals",
        category: "Rent",
        priority: 50,
        enabled: false,
        notes: "lease",
      }),
    ).toEqual(["Rent", "equals", "Rent", 50, "FALSE", "lease"]);
  });
});
