import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { validateCondition, type Cond } from "../rules/dsl.js";
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

export async function approveEntry(
  id: number,
  input: ApproveInput,
  options: { database?: typeof defaultDb; registry?: ApplierRegistry } = {},
): Promise<ApproveResult> {
  const database = options.database ?? defaultDb;
  const registry = options.registry ?? defaultAppliers;
  const pending = await loadPending(id, database);

  let promotedRuleId: number | null = null;
  if (input.promoteToRule) {
    validateCondition(input.promoteToRule.match as Cond);
    const [rule] = await database
      .insert(rules)
      .values({
        domain: pending.domain,
        name: input.promoteToRule.name,
        match: input.promoteToRule.match as never,
        action: pending.proposedAction as never,
        priority: input.promoteToRule.priority ?? 100,
        enabled: true,
        createdFromReviewId: pending.id,
        createdBy: "approval",
      })
      .returning({ id: rules.id });
    promotedRuleId = rule.id;
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

  const apply = await tryApply(
    pending.subjectKind,
    pending.subjectId,
    entry.decision,
    { sessionId: input.sessionId, caller: input.caller, intent: input.intent ?? `review:${id}` },
    registry,
  );

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
  const [entry] = await database
    .update(needsReview)
    .set({
      status: "corrected",
      decision: input.decision as never,
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? "api",
      updatedAt: new Date(),
    })
    .where(eq(needsReview.id, id))
    .returning();

  const apply = await tryApply(
    pending.subjectKind,
    pending.subjectId,
    entry.decision,
    { sessionId: input.sessionId, caller: input.caller, intent: input.intent ?? `review:${id}` },
    registry,
  );

  return { entry, apply };
}
