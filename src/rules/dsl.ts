export type Op =
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "present"
  | "absent"
  | "regex";

export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { field: string; op: Op; value?: unknown };

export class InvalidConditionError extends Error {
  constructor(message: string) {
    super(`invalid match condition: ${message}`);
    this.name = "InvalidConditionError";
  }
}

const STRING_OPS = new Set<Op>(["contains", "starts_with", "ends_with", "regex"]);
const ALL_OPS = new Set<Op>([
  "equals",
  "contains",
  "starts_with",
  "ends_with",
  "in",
  "present",
  "absent",
  "regex",
]);

export function validateCondition(cond: Cond): void {
  if (typeof cond !== "object" || cond == null) {
    throw new InvalidConditionError(`expected object, got ${typeof cond}`);
  }
  if ("all" in cond) {
    if (!Array.isArray(cond.all)) throw new InvalidConditionError("'all' must be an array");
    cond.all.forEach(validateCondition);
    return;
  }
  if ("any" in cond) {
    if (!Array.isArray(cond.any)) throw new InvalidConditionError("'any' must be an array");
    cond.any.forEach(validateCondition);
    return;
  }
  if (!("field" in cond)) {
    throw new InvalidConditionError("must be { all }, { any }, or { field, op, value? }");
  }
  if (typeof cond.field !== "string" || cond.field.length === 0) {
    throw new InvalidConditionError("'field' must be a non-empty string");
  }
  if (!ALL_OPS.has(cond.op)) {
    throw new InvalidConditionError(`unknown op '${cond.op}'`);
  }
  if (cond.op === "regex") {
    if (typeof cond.value !== "string") {
      throw new InvalidConditionError("regex op requires string value");
    }
    try {
      new RegExp(cond.value, "i");
    } catch {
      throw new InvalidConditionError(`invalid regex: ${cond.value}`);
    }
  }
  if (cond.op === "in" && !Array.isArray(cond.value)) {
    throw new InvalidConditionError(`op '${cond.op}' requires array value`);
  }
  if (
    (cond.op === "contains" || cond.op === "starts_with" || cond.op === "ends_with") &&
    typeof cond.value !== "string"
  ) {
    throw new InvalidConditionError(`op '${cond.op}' requires string value`);
  }
}

export function getField(subject: unknown, path: string): unknown {
  if (subject == null || typeof subject !== "object") return undefined;
  let cur: unknown = subject;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evaluateCondition(cond: Cond, subject: unknown): boolean {
  if (typeof cond !== "object" || cond == null) {
    throw new InvalidConditionError(`expected object, got ${typeof cond}`);
  }
  if ("all" in cond) {
    if (!Array.isArray(cond.all)) throw new InvalidConditionError("'all' must be an array");
    for (const sub of cond.all) {
      if (!evaluateCondition(sub, subject)) return false;
    }
    return true;
  }
  if ("any" in cond) {
    if (!Array.isArray(cond.any)) throw new InvalidConditionError("'any' must be an array");
    for (const sub of cond.any) {
      if (evaluateCondition(sub, subject)) return true;
    }
    return false;
  }
  if ("field" in cond) {
    return evalLeaf(cond, subject);
  }
  throw new InvalidConditionError("must be { all }, { any }, or { field, op, value? }");
}

function evalLeaf(
  cond: { field: string; op: Op; value?: unknown },
  subject: unknown,
): boolean {
  const { field, op } = cond;
  if (typeof field !== "string" || field.length === 0) {
    throw new InvalidConditionError("'field' must be a non-empty string");
  }
  const got = getField(subject, field);
  const present = got !== undefined && got !== null;

  if (op === "present") return present;
  if (op === "absent") return !present;

  if (!present) return false;

  if (op === "in") {
    if (!Array.isArray(cond.value)) {
      throw new InvalidConditionError(`op '${op}' requires array value`);
    }
    return cond.value.some((v) => looseEquals(v, got));
  }

  if (op === "equals") return looseEquals(cond.value, got);

  if (STRING_OPS.has(op)) {
    const haystack = typeof got === "string" ? got.toLowerCase() : String(got).toLowerCase();
    if (op === "regex") {
      if (typeof cond.value !== "string") {
        throw new InvalidConditionError("regex op requires string value");
      }
      try {
        return new RegExp(cond.value, "i").test(haystack);
      } catch {
        throw new InvalidConditionError(`invalid regex: ${cond.value}`);
      }
    }
    if (typeof cond.value !== "string") {
      throw new InvalidConditionError(`op '${op}' requires string value`);
    }
    const needle = cond.value.toLowerCase();
    if (op === "contains") return haystack.includes(needle);
    if (op === "starts_with") return haystack.startsWith(needle);
    if (op === "ends_with") return haystack.endsWith(needle);
  }

  throw new InvalidConditionError(`unknown op '${op}'`);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
