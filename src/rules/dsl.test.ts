import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  getField,
  InvalidConditionError,
  validateCondition,
  type Cond,
} from "./dsl.js";

describe("getField", () => {
  it("resolves dot-path through nested objects", () => {
    expect(getField({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });
  it("returns undefined for missing paths", () => {
    expect(getField({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getField({}, "x")).toBeUndefined();
    expect(getField(null, "x")).toBeUndefined();
  });
});

describe("evaluateCondition — string ops", () => {
  const subject = { from: "alice@github.com", subject: "[Issue] something broke" };

  it("equals (case-insensitive)", () => {
    expect(evaluateCondition({ field: "from", op: "equals", value: "ALICE@github.com" }, subject)).toBe(true);
    expect(evaluateCondition({ field: "from", op: "equals", value: "bob@github.com" }, subject)).toBe(false);
  });
  it("contains", () => {
    expect(evaluateCondition({ field: "subject", op: "contains", value: "Issue" }, subject)).toBe(true);
    expect(evaluateCondition({ field: "subject", op: "contains", value: "PR" }, subject)).toBe(false);
  });
  it("starts_with / ends_with", () => {
    expect(evaluateCondition({ field: "from", op: "starts_with", value: "alice" }, subject)).toBe(true);
    expect(evaluateCondition({ field: "from", op: "ends_with", value: "@github.com" }, subject)).toBe(true);
  });
  it("regex", () => {
    expect(evaluateCondition({ field: "subject", op: "regex", value: "^\\[Issue\\]" }, subject)).toBe(true);
    expect(evaluateCondition({ field: "subject", op: "regex", value: "^\\[PR\\]" }, subject)).toBe(false);
  });
});

describe("evaluateCondition — in", () => {
  const subject = { label: "lead" };
  it("in", () => {
    expect(evaluateCondition({ field: "label", op: "in", value: ["lead", "customer"] }, subject)).toBe(true);
    expect(evaluateCondition({ field: "label", op: "in", value: ["other"] }, subject)).toBe(false);
  });
  it("rejects non-array values", () => {
    expect(() => evaluateCondition({ field: "label", op: "in", value: "lead" } as Cond, subject)).toThrow(
      InvalidConditionError,
    );
  });
});

describe("evaluateCondition — present / absent", () => {
  it("present is true for existing values, false for missing", () => {
    expect(evaluateCondition({ field: "x", op: "present" }, { x: 0 })).toBe(true);
    expect(evaluateCondition({ field: "x", op: "present" }, { x: "" })).toBe(true);
    expect(evaluateCondition({ field: "x", op: "present" }, { x: null })).toBe(false);
    expect(evaluateCondition({ field: "x", op: "present" }, {})).toBe(false);
  });
  it("absent is the inverse", () => {
    expect(evaluateCondition({ field: "x", op: "absent" }, {})).toBe(true);
    expect(evaluateCondition({ field: "x", op: "absent" }, { x: 1 })).toBe(false);
  });
});

describe("evaluateCondition — missing field semantics", () => {
  it("affirmative ops return false on missing field; absent returns true", () => {
    expect(evaluateCondition({ field: "missing", op: "equals", value: "x" }, {})).toBe(false);
    expect(evaluateCondition({ field: "missing", op: "contains", value: "x" }, {})).toBe(false);
    expect(evaluateCondition({ field: "missing", op: "in", value: ["x"] }, {})).toBe(false);
    expect(evaluateCondition({ field: "missing", op: "absent" }, {})).toBe(true);
  });
});

describe("evaluateCondition — combinators", () => {
  const subject = { from: "alice@github.com", subject: "[Issue] x" };

  it("all is true only when every sub-condition matches", () => {
    const cond: Cond = {
      all: [
        { field: "from", op: "ends_with", value: "@github.com" },
        { field: "subject", op: "starts_with", value: "[Issue]" },
      ],
    };
    expect(evaluateCondition(cond, subject)).toBe(true);
    expect(
      evaluateCondition(
        { all: [...cond.all, { field: "from", op: "equals", value: "no" }] } as Cond,
        subject,
      ),
    ).toBe(false);
  });

  it("any is true when at least one sub-condition matches", () => {
    const cond: Cond = {
      any: [
        { field: "from", op: "equals", value: "no" },
        { field: "subject", op: "starts_with", value: "[Issue]" },
      ],
    };
    expect(evaluateCondition(cond, subject)).toBe(true);
  });

  it("any short-circuits to false when nothing matches", () => {
    expect(
      evaluateCondition(
        { any: [{ field: "from", op: "equals", value: "no" }] } as Cond,
        subject,
      ),
    ).toBe(false);
  });

  it("nests all/any", () => {
    const cond: Cond = {
      all: [
        { field: "from", op: "ends_with", value: "@github.com" },
        { any: [{ field: "subject", op: "contains", value: "Issue" }, { field: "subject", op: "contains", value: "PR" }] },
      ],
    };
    expect(evaluateCondition(cond, subject)).toBe(true);
  });
});

describe("validateCondition", () => {
  it("rejects a malformed regex eagerly even when no field would match the subject", () => {
    expect(() => validateCondition({ field: "x", op: "regex", value: "[" } as Cond)).toThrow(
      InvalidConditionError,
    );
  });
  it("rejects array ops with non-array values", () => {
    expect(() => validateCondition({ field: "x", op: "in", value: "not-array" } as Cond)).toThrow(
      InvalidConditionError,
    );
  });
  it("rejects string ops with non-string values", () => {
    expect(() => validateCondition({ field: "x", op: "contains", value: 42 } as Cond)).toThrow(
      InvalidConditionError,
    );
  });
  it("walks into all/any combinators", () => {
    expect(() =>
      validateCondition({
        all: [{ field: "x", op: "regex", value: "[" }],
      } as Cond),
    ).toThrow(InvalidConditionError);
  });
  it("accepts a valid nested condition", () => {
    expect(() =>
      validateCondition({
        all: [
          { field: "from", op: "ends_with", value: "@github.com" },
          { any: [{ field: "subject", op: "regex", value: "^\\[Issue\\]" }] },
        ],
      }),
    ).not.toThrow();
  });
});

describe("evaluateCondition — invalid input", () => {
  it("throws on unknown op", () => {
    expect(() => evaluateCondition({ field: "x", op: "weird" } as never, { x: 1 })).toThrow(InvalidConditionError);
  });
  it("throws on missing field name", () => {
    expect(() => evaluateCondition({ field: "", op: "equals", value: 1 } as Cond, {})).toThrow(
      InvalidConditionError,
    );
  });
  it("throws on invalid regex source", () => {
    expect(() =>
      evaluateCondition({ field: "x", op: "regex", value: "[" } as Cond, { x: "anything" }),
    ).toThrow(InvalidConditionError);
  });
});
