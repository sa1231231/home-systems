import { describe, expect, it } from "vitest";
import { getDomainConfig, UnknownDomainError } from "./domains.js";
import type { needsReview } from "../db/schema.js";

type Row = typeof needsReview.$inferSelect;

function makeEntry(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    domain: "email",
    subject: {},
    subjectKind: "email",
    subjectId: "msg-1",
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

  describe("email config", () => {
    const cfg = getDomainConfig("email");

    it("validates the email category enum", () => {
      expect(cfg.validateCorrection({ category: "noise" })).toEqual({ category: "noise" });
      expect(cfg.validateCorrection({ category: "worth_reading" })).toEqual({
        category: "worth_reading",
      });
      expect(cfg.validateCorrection({ category: "needs_reply" })).toEqual({
        category: "needs_reply",
      });
      expect(() => cfg.validateCorrection({ category: "bogus" })).toThrow();
      expect(() => cfg.validateCorrection({})).toThrow();
    });

    it("defaultRuleName uses the sender when present", () => {
      const e = makeEntry({ subject: { from: "alice@example.com" } });
      expect(cfg.defaultRuleName(e)).toBe("auto: from=alice@example.com");
    });

    it("defaultRuleName truncates long senders to 80 chars", () => {
      const long = "a".repeat(120) + "@example.com";
      const e = makeEntry({ subject: { from: long } });
      const name = cfg.defaultRuleName(e);
      expect(name.startsWith("auto: from=")).toBe(true);
      expect(name.length).toBe("auto: from=".length + 80);
    });

    it("defaultRuleName falls back to id when sender missing", () => {
      const e = makeEntry({ id: 42, subject: {} });
      expect(cfg.defaultRuleName(e)).toBe("auto: review #42");
    });

    it("defaultMatch prefers from, then subject, then a presence sentinel", () => {
      expect(cfg.defaultMatch(makeEntry({ subject: { from: "a@b" } }))).toEqual({
        op: "equals",
        field: "from",
        value: "a@b",
      });
      expect(cfg.defaultMatch(makeEntry({ subject: { subject: "hello" } }))).toEqual({
        op: "equals",
        field: "subject",
        value: "hello",
      });
      expect(cfg.defaultMatch(makeEntry({ subject: {} }))).toEqual({
        op: "present",
        field: "from",
      });
    });

    it("buildCorrectedDecision records both new and previous category", () => {
      const dec = cfg.buildCorrectedDecision("noise", "needs_reply") as Record<string, string>;
      expect(dec.category).toBe("noise");
      expect(dec.reasoning).toContain("needs_reply");
    });
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
