import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { InvalidConditionError, validateCondition, type Cond } from "../rules/dsl.js";

const ListQuery = z.object({
  domain: z.string().min(1).max(100).optional(),
  status: z.enum(["pending", "approved", "rejected", "corrected"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const IdParam = z.coerce.number().int().positive();

const CreateBody = z.object({
  domain: z.string().min(1).max(100),
  subject: z.unknown().optional(),
  subject_kind: z.string().min(1).max(100),
  subject_id: z.string().min(1).max(200),
  ai_call_id: z.number().int().positive().optional(),
  proposed_action: z.unknown(),
  notes: z.string().max(2000).optional(),
});

const ApproveBody = z
  .object({
    promote_to_rule: z
      .object({
        name: z.string().min(1).max(200),
        match: z.unknown(),
        priority: z.number().int().min(0).max(10000).optional(),
      })
      .optional(),
    decided_by: z.string().min(1).max(100).optional(),
  })
  .optional();

const RejectBody = z
  .object({
    decided_by: z.string().min(1).max(100).optional(),
    reason: z.string().max(2000).optional(),
  })
  .optional();

const CorrectBody = z.object({
  decision: z.unknown(),
  decided_by: z.string().min(1).max(100).optional(),
});

function rowToJson(row: typeof needsReview.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    domain: row.domain,
    subject: row.subject,
    subject_kind: row.subjectKind,
    subject_id: row.subjectId,
    ai_call_id: row.aiCallId,
    proposed_action: row.proposedAction,
    status: row.status,
    decision: row.decision,
    decided_at: row.decidedAt,
    decided_by: row.decidedBy,
    promoted_to_rule_id: row.promotedToRuleId,
    notes: row.notes,
  };
}

class EntryNotFoundError extends Error {
  constructor(public readonly id: number) {
    super(`needs_review entry ${id} not found`);
    this.name = "EntryNotFoundError";
  }
}

class AlreadyDecidedError extends Error {
  constructor(public readonly id: number, public readonly status: string) {
    super(`needs_review entry ${id} already decided (status='${status}')`);
    this.name = "AlreadyDecidedError";
  }
}

async function loadPending(id: number): Promise<typeof needsReview.$inferSelect> {
  const [row] = await db.select().from(needsReview).where(eq(needsReview.id, id));
  if (!row) throw new EntryNotFoundError(id);
  if (row.status !== "pending") throw new AlreadyDecidedError(id, row.status);
  return row;
}

export function makeNeedsReviewRouter(): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const body = CreateBody.parse(req.body);
      const [row] = await db
        .insert(needsReview)
        .values({
          domain: body.domain,
          subject: (body.subject ?? {}) as never,
          subjectKind: body.subject_kind,
          subjectId: body.subject_id,
          aiCallId: body.ai_call_id ?? null,
          proposedAction: body.proposed_action as never,
          status: "pending",
          notes: body.notes ?? null,
        })
        .returning();
      res.status(201).json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/", async (req, res) => {
    try {
      const q = ListQuery.parse(req.query);
      const filters = [
        q.domain !== undefined ? eq(needsReview.domain, q.domain) : undefined,
        q.status !== undefined ? eq(needsReview.status, q.status) : undefined,
      ].filter((x): x is NonNullable<typeof x> => x !== undefined);
      const where = filters.length > 0 ? and(...filters) : undefined;
      const rows = await db
        .select()
        .from(needsReview)
        .where(where)
        .orderBy(desc(needsReview.id))
        .limit(q.limit);
      res.json({ ok: true, count: rows.length, entries: rows.map(rowToJson) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const [row] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      if (!row) throw new EntryNotFoundError(id);
      res.json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:id/approve", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const body = ApproveBody.parse(req.body);
      const pending = await loadPending(id);

      let promotedRuleId: number | null = null;
      if (body?.promote_to_rule) {
        validateCondition(body.promote_to_rule.match as Cond);
        const [rule] = await db
          .insert(rules)
          .values({
            domain: pending.domain,
            name: body.promote_to_rule.name,
            match: body.promote_to_rule.match as never,
            action: pending.proposedAction as never,
            priority: body.promote_to_rule.priority ?? 100,
            enabled: true,
            createdFromReviewId: pending.id,
            createdBy: "approval",
          })
          .returning({ id: rules.id });
        promotedRuleId = rule.id;
      }

      const [row] = await db
        .update(needsReview)
        .set({
          status: "approved",
          decision: pending.proposedAction as never,
          decidedAt: new Date(),
          decidedBy: body?.decided_by ?? "api",
          promotedToRuleId: promotedRuleId,
          updatedAt: new Date(),
        })
        .where(eq(needsReview.id, id))
        .returning();

      res.json({ ok: true, entry: rowToJson(row), promoted_rule_id: promotedRuleId });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:id/reject", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const body = RejectBody.parse(req.body);
      await loadPending(id);

      const [row] = await db
        .update(needsReview)
        .set({
          status: "rejected",
          decidedAt: new Date(),
          decidedBy: body?.decided_by ?? "api",
          notes: body?.reason ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(needsReview.id, id))
        .returning();

      res.json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:id/correct", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const body = CorrectBody.parse(req.body);
      await loadPending(id);

      const [row] = await db
        .update(needsReview)
        .set({
          status: "corrected",
          decision: body.decision as never,
          decidedAt: new Date(),
          decidedBy: body.decided_by ?? "api",
          updatedAt: new Date(),
        })
        .where(eq(needsReview.id, id))
        .returning();

      res.json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  if (err instanceof EntryNotFoundError) {
    res.status(404).json({ ok: false, error: err.message, id: err.id });
    return;
  }
  if (err instanceof AlreadyDecidedError) {
    res.status(409).json({ ok: false, error: err.message, id: err.id, status: err.status });
    return;
  }
  if (err instanceof InvalidConditionError) {
    res.status(400).json({ ok: false, error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "invalid request", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
