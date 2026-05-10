import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";
import { InvalidConditionError, validateCondition, type Cond } from "../rules/dsl.js";

const ListQuery = z.object({
  domain: z.string().min(1).max(100).optional(),
  enabled: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const IdParam = z.coerce.number().int().positive();

const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(CondSchema) }).strict(),
    z.object({ any: z.array(CondSchema) }).strict(),
    z
      .object({
        field: z.string().min(1).max(200),
        op: z.enum([
          "equals",
          "contains",
          "starts_with",
          "ends_with",
          "in",
          "present",
          "absent",
          "regex",
        ]),
        value: z.unknown().optional(),
      })
      .strict(),
  ]),
);

const CreateBody = z.object({
  domain: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  match: CondSchema,
  action: z.unknown(),
  priority: z.number().int().min(0).max(10000).optional(),
  notes: z.string().max(2000).optional(),
});

function rowToJson(row: typeof rules.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    domain: row.domain,
    name: row.name,
    match: row.match,
    action: row.action,
    priority: row.priority,
    enabled: row.enabled,
    created_from_review_id: row.createdFromReviewId,
    created_by: row.createdBy,
    notes: row.notes,
  };
}

class EntryNotFoundError extends Error {
  constructor(public readonly id: number) {
    super(`rule ${id} not found`);
    this.name = "EntryNotFoundError";
  }
}

export function makeRulesRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const q = ListQuery.parse(req.query);
      const filters = [
        q.domain !== undefined ? eq(rules.domain, q.domain) : undefined,
        q.enabled !== undefined ? eq(rules.enabled, q.enabled) : undefined,
      ].filter((x): x is NonNullable<typeof x> => x !== undefined);
      const where = filters.length > 0 ? and(...filters) : undefined;
      const rows = await db
        .select()
        .from(rules)
        .where(where)
        .orderBy(asc(rules.domain), asc(rules.priority), asc(rules.id));
      res.json({ ok: true, count: rows.length, entries: rows.map(rowToJson) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const [row] = await db.select().from(rules).where(eq(rules.id, id));
      if (!row) throw new EntryNotFoundError(id);
      res.json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const body = CreateBody.parse(req.body);
      validateCondition(body.match);
      const [row] = await db
        .insert(rules)
        .values({
          domain: body.domain,
          name: body.name,
          match: body.match,
          action: body.action as never,
          priority: body.priority ?? 100,
          enabled: true,
          createdBy: "api",
          notes: body.notes ?? null,
        })
        .returning();
      res.status(201).json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:id/disable", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const [row] = await db
        .update(rules)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(rules.id, id))
        .returning();
      if (!row) throw new EntryNotFoundError(id);
      res.json({ ok: true, entry: rowToJson(row) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:id/enable", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const [row] = await db
        .update(rules)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(rules.id, id))
        .returning();
      if (!row) throw new EntryNotFoundError(id);
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
