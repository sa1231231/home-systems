import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { evaluateCondition, validateCondition, type Cond } from "../rules/dsl.js";
import { isSituational } from "../rules/engine.js";
import { reviewAppliers as defaultAppliers, type ApplierRegistry } from "./appliers.js";

export type NeedsReviewRow = typeof needsReview.$inferSelect;

export class EntryNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly id: number) {
    super(`needs_review entry ${id} not found`);
    this.name = "EntryNotFoundError";
  }
}

export class AlreadyDecidedError extends Error {
  readonly status = 409;
  constructor(readonly id: number, readonly currentStatus: string) {
    super(`needs_review entry ${id} already decided (status='${currentStatus}')`);
    this.name = "AlreadyDecidedError";
  }
}

export type ApplyMeta = {
  sessionId: string;
  caller: string;
  intent?: string;
  /** For email reviews: which Gmail account the subject belongs to. */
  account?: string;
};

export type ApplyOutcome = {
  applied: boolean;
  apply_result?: unknown;
  apply_error?: string;
};

export type PromoteToRuleInput = {
  name: string;
  match: unknown;
  priority?: number;
};

export type ApproveInput = {
  promoteToRule?: PromoteToRuleInput;
  decidedBy?: string;
} & ApplyMeta;

export type RejectInput = {
  decidedBy?: string;
  reason?: string;
};

export type CorrectInput = {
  decision: unknown;
  decidedBy?: string;
  promoteToRule?: PromoteToRuleInput;
} & ApplyMeta;

export type ApproveResult = {
  entry: NeedsReviewRow;
  promotedRuleId: number | null;
  apply: ApplyOutcome;
};

export type RejectResult = {
  entry: NeedsReviewRow;
};

export type CorrectResult = {
  entry: NeedsReviewRow;
  promotedRuleId: number | null;
  apply: ApplyOutcome;
};

/**
 * Attempt to apply a decision through the registered applier for `subjectKind`.
 * Always returns — registry misses and applier errors are encoded into the
 * outcome rather than thrown.
 */
export async function tryApply(
  subjectKind: string,
  subjectId: string,
  decision: unknown,
  meta: ApplyMeta,
  registry: ApplierRegistry = defaultAppliers,
): Promise<ApplyOutcome> {
  if (!registry.has(subjectKind)) {
    return { applied: false, apply_error: `no applier registered for '${subjectKind}'` };
  }
  try {
    const result = await registry.apply(subjectKind, subjectId, decision, meta);
    return { applied: true, apply_result: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: false, apply_error: message };
  }
}

export async function loadPending(
  id: number,
  database: typeof defaultDb = defaultDb,
): Promise<NeedsReviewRow> {
  const [row] = await database.select().from(needsReview).where(eq(needsReview.id, id));
  if (!row) throw new EntryNotFoundError(id);
  if (row.status !== "pending") throw new AlreadyDecidedError(id, row.status);
  return row;
}

/**
 * True if the condition contains a `present`/`absent` leaf. Those are too
 * broad to safely promote into a rule — they would match every subject in
 * the domain (e.g. every email in an account), not a specific sender.
 */
function hasUnsafeLeaf(cond: Cond): boolean {
  if ("all" in cond) return cond.all.some(hasUnsafeLeaf);
  if ("any" in cond) return cond.any.some(hasUnsafeLeaf);
  if ("field" in cond) return cond.op === "present" || cond.op === "absent";
  return false;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "23505";
}

function categoryOf(action: unknown): unknown {
  return action && typeof action === "object"
    ? (action as Record<string, unknown>).category
    : undefined;
}

const ruleMatchFilter = (domain: string, match: unknown) =>
  and(eq(rules.domain, domain), eq(rules.enabled, true), eq(rules.match, match as never));

/**
 * Create the rule for an approved/corrected review — idempotently. If an
 * enabled rule with the same (domain, match) already exists it is reused,
 * and its action is updated when the category differs (newest decision
 * wins). Returns the rule id, or null when the match is too broad to promote.
 */
export async function promoteRule(
  database: typeof defaultDb,
  params: {
    domain: string;
    name: string;
    match: unknown;
    action: unknown;
    priority?: number;
    reviewId: number | null;
    createdBy: string;
  },
): Promise<number | null> {
  const match = params.match as Cond;
  validateCondition(match);
  if (hasUnsafeLeaf(match)) return null;

  const [existing] = await database
    .select({ id: rules.id, action: rules.action })
    .from(rules)
    .where(ruleMatchFilter(params.domain, params.match))
    .limit(1);

  if (existing) {
    if (categoryOf(existing.action) !== categoryOf(params.action)) {
      await database
        .update(rules)
        .set({ action: params.action as never, updatedAt: new Date() })
        .where(eq(rules.id, existing.id));
    }
    return existing.id;
  }

  try {
    const [rule] = await database
      .insert(rules)
      .values({
        domain: params.domain,
        name: params.name,
        match: params.match as never,
        action: params.action as never,
        priority: params.priority ?? 100,
        enabled: true,
        createdFromReviewId: params.reviewId ?? null,
        createdBy: params.createdBy,
      })
      .returning({ id: rules.id });
    return rule.id;
  } catch (err) {
    // A concurrent insert won the race against the unique index — reuse it.
    if (isUniqueViolation(err)) {
      const [row] = await database
        .select({ id: rules.id })
        .from(rules)
        .where(ruleMatchFilter(params.domain, params.match))
        .limit(1);
      if (row) return row.id;
    }
    throw err;
  }
}

/**
 * After a rule is created, auto-resolve any other still-pending reviews that
 * the new rule matches — the user designated this sender once, so they
 * shouldn't have to review it again. Each match is approved with the rule's
 * action, and the action is applied to the source.
 */
export async function autoResolveMatching(
  database: typeof defaultDb,
  ruleId: number,
  meta: ApplyMeta,
  registry: ApplierRegistry,
): Promise<void> {
  const [rule] = await database.select().from(rules).where(eq(rules.id, ruleId)).limit(1);
  if (!rule) return;
  const pendingRows = await database
    .select()
    .from(needsReview)
    .where(and(eq(needsReview.domain, rule.domain), eq(needsReview.status, "pending")));
  for (const row of pendingRows) {
    let matches = false;
    try {
      matches = evaluateCondition(rule.match as Cond, row.subject);
    } catch {
      matches = false;
    }
    if (!matches) continue;
    await database
      .update(needsReview)
      .set({
        status: "approved",
        decision: rule.action as never,
        decidedAt: new Date(),
        decidedBy: `auto:rule-${ruleId}`,
        promotedToRuleId: ruleId,
        updatedAt: new Date(),
      })
      .where(eq(needsReview.id, row.id));
    const account = (row.subject as { account?: string } | null)?.account;
    await tryApply(row.subjectKind, row.subjectId, rule.action, { ...meta, account }, registry);
  }
}

/**
 * True if an enabled situational rule (`action.situational === true`) in the
 * domain matches this subject. Such merchants have a genuinely variable
 * category, so we apply the chosen category once but never promote a rule —
 * this guards every approve/correct path (quick, bulk, and the decide form).
 */
async function blockedBySituationalRule(
  database: typeof defaultDb,
  domain: string,
  subject: unknown,
): Promise<boolean> {
  const candidates = await database
    .select({ match: rules.match, action: rules.action })
    .from(rules)
    .where(and(eq(rules.domain, domain), eq(rules.enabled, true)));
  for (const r of candidates) {
    if (!isSituational(r.action)) continue;
    try {
      if (evaluateCondition(r.match as Cond, subject)) return true;
    } catch {
      /* a rule we can't evaluate simply doesn't block */
    }
  }
  return false;
}

export async function approveEntry(
  id: number,
  input: ApproveInput,
  options: { database?: typeof defaultDb; registry?: ApplierRegistry } = {},
): Promise<ApproveResult> {
  const database = options.database ?? defaultDb;
  const registry = options.registry ?? defaultAppliers;
  const pending = await loadPending(id, database);

  let promotedRuleId: number | null = null;
  if (
    input.promoteToRule &&
    !(await blockedBySituationalRule(database, pending.domain, pending.subject))
  ) {
    promotedRuleId = await promoteRule(database, {
      domain: pending.domain,
      name: input.promoteToRule.name,
      match: input.promoteToRule.match,
      action: pending.proposedAction,
      priority: input.promoteToRule.priority,
      reviewId: pending.id,
      createdBy: "approval",
    });
  }

  const [entry] = await database
    .update(needsReview)
    .set({
      status: "approved",
      decision: pending.proposedAction as never,
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? "api",
      promotedToRuleId: promotedRuleId,
      updatedAt: new Date(),
    })
    .where(eq(needsReview.id, id))
    .returning();

  const meta: ApplyMeta = {
    sessionId: input.sessionId,
    caller: input.caller,
    intent: input.intent ?? `review:${id}`,
  };
  const account = (pending.subject as { account?: string } | null)?.account;
  const apply = await tryApply(
    pending.subjectKind,
    pending.subjectId,
    entry.decision,
    { ...meta, account },
    registry,
  );
  if (promotedRuleId !== null) {
    await autoResolveMatching(database, promotedRuleId, meta, registry);
  }

  return { entry, promotedRuleId, apply };
}

export async function rejectEntry(
  id: number,
  input: RejectInput,
  options: { database?: typeof defaultDb } = {},
): Promise<RejectResult> {
  const database = options.database ?? defaultDb;
  await loadPending(id, database);
  const [entry] = await database
    .update(needsReview)
    .set({
      status: "rejected",
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? "api",
      notes: input.reason ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(needsReview.id, id))
    .returning();
  return { entry };
}

export async function correctEntry(
  id: number,
  input: CorrectInput,
  options: { database?: typeof defaultDb; registry?: ApplierRegistry } = {},
): Promise<CorrectResult> {
  const database = options.database ?? defaultDb;
  const registry = options.registry ?? defaultAppliers;
  const pending = await loadPending(id, database);

  let promotedRuleId: number | null = null;
  if (
    input.promoteToRule &&
    !(await blockedBySituationalRule(database, pending.domain, pending.subject))
  ) {
    promotedRuleId = await promoteRule(database, {
      domain: pending.domain,
      name: input.promoteToRule.name,
      match: input.promoteToRule.match,
      // The rule's action is the *corrected* decision, not the AI's original proposal.
      action: input.decision,
      priority: input.promoteToRule.priority,
      reviewId: pending.id,
      createdBy: "correction",
    });
  }

  const [entry] = await database
    .update(needsReview)
    .set({
      status: "corrected",
      decision: input.decision as never,
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? "api",
      promotedToRuleId: promotedRuleId,
      updatedAt: new Date(),
    })
    .where(eq(needsReview.id, id))
    .returning();

  const meta: ApplyMeta = {
    sessionId: input.sessionId,
    caller: input.caller,
    intent: input.intent ?? `review:${id}`,
  };
  const account = (pending.subject as { account?: string } | null)?.account;
  const apply = await tryApply(
    pending.subjectKind,
    pending.subjectId,
    entry.decision,
    { ...meta, account },
    registry,
  );
  if (promotedRuleId !== null) {
    await autoResolveMatching(database, promotedRuleId, meta, registry);
  }

  return { entry, promotedRuleId, apply };
}
