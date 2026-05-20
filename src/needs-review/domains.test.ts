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
        all: [{ op: "equals", field: "from", value: "a@b" }],
      });
      expect(cfg.defaultMatch(makeEntry({ subject: { subject: "hello" } }))).toEqual({
        all: [{ op: "equals", field: "subject", value: "hello" }],
      });
      expect(cfg.defaultMatch(makeEntry({ subject: {} }))).toEqual({
        all: [{ op: "present", field: "from" }],
      });
    });

    it("defaultMatch scopes the rule to the account when present", () => {
      expect(
        cfg.defaultMatch(makeEntry({ subject: { account: "me@gmail.com", from: "a@b" } })),
      ).toEqual({
        all: [
          { op: "equals", field: "account", value: "me@gmail.com" },
          { op: "equals", field: "from", value: "a@b" },
        ],
      });
    });

    it("buildCorrectedDecision records both new and previous category", () => {
      const dec = cfg.buildCorrectedDecision("noise", "needs_reply") as Record<string, string>;
      expect(dec.category).toBe("noise");
      expect(dec.reasoning).toContain("needs_reply");
    });

    describe("validateCorrection with rule scope", () => {
      it("accepts a body with rule_scope and rule_value", () => {
        expect(
          cfg.validateCorrection({
            category: "noise",
            rule_scope: "from_domain",
            rule_value: "@txt.voice.google.com",
          }),
        ).toEqual({
          category: "noise",
          rule_scope: "from_domain",
          rule_value: "@txt.voice.google.com",
        });
      });
      it("rejects an unknown rule_scope", () => {
        expect(() =>
          cfg.validateCorrection({ category: "noise", rule_scope: "from_subdomain" }),
        ).toThrow();
      });
    });

    describe("buildPromoteFromCorrection", () => {
      const entryFor = (subject: Record<string, unknown>) => makeEntry({ subject });

      it("falls back to defaults when rule_scope is omitted", () => {
        const e = entryFor({ account: "me@gmail.com", from: "alice@x.com" });
        const promo = cfg.buildPromoteFromCorrection!(e, { category: "noise" } as never);
        expect(promo).toEqual({
          name: "auto: me@gmail.com from=alice@x.com",
          match: {
            all: [
              { op: "equals", field: "account", value: "me@gmail.com" },
              { op: "equals", field: "from", value: "alice@x.com" },
            ],
          },
        });
      });

      it("rule_scope=once returns undefined (no rule promoted)", () => {
        const e = entryFor({ from: "alice@x.com" });
        const promo = cfg.buildPromoteFromCorrection!(
          e,
          { category: "noise", rule_scope: "once" } as never,
        );
        expect(promo).toBeUndefined();
      });

      it("rule_scope=exact still returns the default rule", () => {
        const e = entryFor({ from: "alice@x.com" });
        const promo = cfg.buildPromoteFromCorrection!(
          e,
          { category: "noise", rule_scope: "exact" } as never,
        );
        expect(promo).toEqual({
          name: "auto: from=alice@x.com",
          match: { all: [{ op: "equals", field: "from", value: "alice@x.com" }] },
        });
      });

      it("rule_scope=from_domain builds a `from contains @domain` rule", () => {
        const e = entryFor({
          account: "me@gmail.com",
          from: '"(804) 214-6360" <15715778596.18042146360.x5sj71RFqL@txt.voice.google.com>',
        });
        const promo = cfg.buildPromoteFromCorrection!(
          e,
          {
            category: "needs_reply",
            rule_scope: "from_domain",
            rule_value: "@txt.voice.google.com",
          } as never,
        );
        expect(promo).toEqual({
          name: "auto: me@gmail.com from contains @txt.voice.google.com",
          match: {
            all: [
              { op: "equals", field: "account", value: "me@gmail.com" },
              { op: "contains", field: "from", value: "@txt.voice.google.com" },
            ],
          },
        });
      });

      it("from_domain prepends @ if the user omits it", () => {
        const e = entryFor({ from: "x@y.com" });
        const promo = cfg.buildPromoteFromCorrection!(
          e,
          {
            category: "noise",
            rule_scope: "from_domain",
            rule_value: "txt.voice.google.com",
          } as never,
        );
        expect((promo!.match as { all: Array<{ value: string }> }).all[0].value).toBe(
          "@txt.voice.google.com",
        );
      });

      it("rule_scope=from_contains builds a `from contains <value>` rule", () => {
        const e = entryFor({ account: "me@gmail.com", from: "anyone" });
        const promo = cfg.buildPromoteFromCorrection!(
          e,
          {
            category: "needs_reply",
            rule_scope: "from_contains",
            rule_value: "(804) 214-6360",
          } as never,
        );
        expect(promo).toEqual({
          name: "auto: me@gmail.com from contains (804) 214-6360",
          match: {
            all: [
              { op: "equals", field: "account", value: "me@gmail.com" },
              { op: "contains", field: "from", value: "(804) 214-6360" },
            ],
          },
        });
      });

      it("rule_scope=subject_contains builds a `subject contains <value>` rule", () => {
        const e = entryFor({ subject: "weekly digest", account: "me@gmail.com" });
        const promo = cfg.buildPromoteFromCorrection!(
          e,
          {
            category: "noise",
            rule_scope: "subject_contains",
            rule_value: "digest",
          } as never,
        );
        expect(promo).toEqual({
          name: "auto: me@gmail.com subject contains digest",
          match: {
            all: [
              { op: "equals", field: "account", value: "me@gmail.com" },
              { op: "contains", field: "subject", value: "digest" },
            ],
          },
        });
      });

      it("throws when a contains/domain scope is missing rule_value", () => {
        const e = entryFor({ from: "x@y.com" });
        expect(() =>
          cfg.buildPromoteFromCorrection!(
            e,
            { category: "noise", rule_scope: "from_contains" } as never,
          ),
        ).toThrow(/rule_value is required/);
      });
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
