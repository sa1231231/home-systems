import { describe, expect, it } from "vitest";
import { pickFirstMatch, type RuleRow } from "./engine.js";
import type { Cond } from "./dsl.js";

function rule(overrides: Partial<RuleRow> & { match: Cond; action: unknown }): RuleRow {
  return {
    id: 1,
    createdAt: new Date("2026-05-10T00:00:00Z"),
    updatedAt: new Date("2026-05-10T00:00:00Z"),
    domain: "email",
    name: "test rule",
    priority: 100,
    enabled: true,
    createdFromReviewId: null,
    createdBy: "seed",
    notes: null,
    ...overrides,
    match: overrides.match,
    action: overrides.action,
  } as RuleRow;
}

describe("pickFirstMatch", () => {
  const subject = { from: "alice@github.com", subject: "[Issue] something" };

  it("returns the first rule whose match passes", () => {
    const rules = [
      rule({
        id: 1,
        priority: 100,
        match: { field: "from", op: "ends_with", value: "@example.com" },
        action: { kind: "skip" },
      }),
      rule({
        id: 2,
        priority: 100,
        match: { field: "from", op: "ends_with", value: "@github.com" },
        action: { kind: "label", value: "github" },
      }),
    ];
    const match = pickFirstMatch(rules, subject);
    expect(match).not.toBeNull();
    expect(match?.rule.id).toBe(2);
    expect(match?.action).toEqual({ kind: "label", value: "github" });
  });

  it("returns null when no rule matches", () => {
    const rules = [
      rule({
        id: 1,
        match: { field: "from", op: "ends_with", value: "@nope.com" },
        action: { kind: "x" },
      }),
    ];
    expect(pickFirstMatch(rules, subject)).toBeNull();
  });

  it("respects caller-supplied ordering (priority then id is the engine loader's job, not pickFirstMatch's)", () => {
    // pickFirstMatch is order-preserving; the engine.loadEnabledRules sorts. This test
    // documents the contract by passing rules in already-sorted order.
    const rules = [
      rule({
        id: 5,
        priority: 50,
        match: { field: "from", op: "ends_with", value: "@github.com" },
        action: { kind: "high-priority" },
      }),
      rule({
        id: 2,
        priority: 100,
        match: { field: "from", op: "ends_with", value: "@github.com" },
        action: { kind: "low-priority" },
      }),
    ];
    expect(pickFirstMatch(rules, subject)?.action).toEqual({ kind: "high-priority" });
  });

  it("treats action as opaque — returns whatever was stored", () => {
    const action = { archive: true, label: "auto", reasons: ["sender-match"] };
    const match = pickFirstMatch(
      [rule({ id: 1, match: { field: "from", op: "present" }, action })],
      subject,
    );
    expect(match?.action).toBe(action);
  });
});
