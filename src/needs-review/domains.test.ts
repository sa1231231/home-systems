import { describe, expect, it } from "vitest";
import { getDomainConfig, UnknownDomainError } from "./domains.js";
import type { needsReview } from "../db/schema.js";

type Row = typeof needsReview.$inferSelect;

function makeEntry(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    domain: "transaction",
    subject: {},
    subjectKind: "transaction",
    subjectId: "tx-1",
    aiCallId: null,
    proposedAction: {},
    status: "pending",
    decision: null,
    decidedAt: null,
    decidedBy: null,
    promotedToRuleId: null,
    notes: null,
    ...overrides,
  } as Row;
}

describe("getDomainConfig", () => {
  it("throws UnknownDomainError for an unregistered domain", () => {
    expect(() => getDomainConfig("nope")).toThrow(UnknownDomainError);
    try {
      getDomainConfig("nope");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDomainError);
      expect((err as UnknownDomainError).status).toBe(400);
      expect((err as UnknownDomainError).domain).toBe("nope");
    }
  });

  describe("transaction config", () => {
    const cfg = getDomainConfig("transaction");

    it("validates any non-empty category (enum is dynamic at apply time)", () => {
      expect(cfg.validateCorrection({ category: "Groceries / Food" })).toEqual({
        category: "Groceries / Food",
      });
      expect(() => cfg.validateCorrection({ category: "" })).toThrow();
      expect(() => cfg.validateCorrection({ category: "x".repeat(201) })).toThrow();
      expect(() => cfg.validateCorrection({})).toThrow();
    });

    it("defaultRuleName prefers full_description, then description, then id", () => {
      expect(cfg.defaultRuleName(makeEntry({ subject: { full_description: "AMAZON" } }))).toBe(
        "auto: AMAZON",
      );
      expect(cfg.defaultRuleName(makeEntry({ subject: { description: "Amazon" } }))).toBe(
        "auto: Amazon",
      );
      expect(cfg.defaultRuleName(makeEntry({ id: 9, subject: {} }))).toBe("auto: review #9");
    });

    it("defaultRuleName truncates long descriptions to 80 chars after prefix", () => {
      const long = "x".repeat(120);
      const e = makeEntry({ subject: { full_description: long } });
      expect(cfg.defaultRuleName(e).length).toBe("auto: ".length + 80);
    });

    it("defaultMatch prefers full_description, then description, then a presence sentinel", () => {
      expect(
        cfg.defaultMatch(makeEntry({ subject: { full_description: "AMAZON" } })),
      ).toEqual({ op: "equals", field: "full_description", value: "AMAZON" });
      expect(cfg.defaultMatch(makeEntry({ subject: { description: "Amazon" } }))).toEqual({
        op: "equals",
        field: "description",
        value: "Amazon",
      });
      expect(cfg.defaultMatch(makeEntry({ subject: {} }))).toEqual({
        op: "present",
        field: "transaction_id",
      });
    });

    it("buildCorrectedDecision records both new and previous category", () => {
      const dec = cfg.buildCorrectedDecision("Dining", "Groceries") as Record<string, string>;
      expect(dec.category).toBe("Dining");
      expect(dec.reasoning).toContain("Groceries");
    });
  });
});
