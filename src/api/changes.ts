import { Router } from "express";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { NoReverserError, registry } from "../changelog/index.js";
import type { ChangelogRow } from "../changelog/types.js";

const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const UndoLastNBody = z.object({
  operation: z.string().min(1).max(200),
  n: z.coerce.number().int().min(1).max(100),
});

const IdParam = z.coerce.number().int().positive();

function rowToJson(row: typeof changelog.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    created_at: row.createdAt,
    caller: row.caller,
    session_id: row.sessionId,
    operation: row.operation,
    target_kind: row.targetKind,
    target_id: row.targetId,
    intent: row.intent,
    before_state: row.beforeState,
    after_state: row.afterState,
    external_target: row.externalTarget,
    status: row.status,
    error: row.error,
    undone_by: row.undoneBy,
  };
}

function toEntry(row: typeof changelog.$inferSelect): ChangelogRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    caller: row.caller,
    sessionId: row.sessionId,
    operation: row.operation,
    targetKind: row.targetKind,
    targetId: row.targetId,
    intent: row.intent,
    beforeState: row.beforeState as Record<string, unknown>,
    afterState: row.afterState as Record<string, unknown>,
    externalTarget: row.externalTarget,
    status: row.status as ChangelogRow["status"],
    error: row.error,
    undoneBy: row.undoneBy,
  };
}

export function makeChangesRouter(): Router {
  const router = Router();

  router.get("/recent", async (req, res) => {
    try {
      const { limit } = RecentQuery.parse(req.query);
      const rows = await db.select().from(changelog).orderBy(desc(changelog.id)).limit(limit);
      res.json({ ok: true, count: rows.length, entries: rows.map(rowToJson) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/session/:sessionId", async (req, res) => {
    try {
      const sessionId = z.string().uuid().or(z.string().min(1).max(200)).parse(req.params.sessionId);
      const rows = await db
        .select()
        .from(changelog)
        .where(eq(changelog.sessionId, sessionId))
        .orderBy(asc(changelog.id));
      res.json({ ok: true, count: rows.length, entries: rows.map(rowToJson) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/undo/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const result = await reverseOne(id);
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/undo-last-n", async (req, res) => {
    try {
      const { operation, n } = UndoLastNBody.parse(req.body);
      const candidates = await db
        .select()
        .from(changelog)
        .where(
          and(
            eq(changelog.operation, operation),
            eq(changelog.status, "success"),
            isNull(changelog.undoneBy),
          ),
        )
        .orderBy(desc(changelog.id))
        .limit(n);
      const reversed: number[] = [];
      const failures: { id: number; error: string }[] = [];
      for (const row of candidates) {
        try {
          await reverseOne(row.id);
          reversed.push(row.id);
        } catch (err) {
          failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      res.json({ ok: failures.length === 0, reversed, failures });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/rollback-session/:sessionId", async (req, res) => {
    try {
      const sessionId = z.string().min(1).max(200).parse(req.params.sessionId);
      const candidates = await db
        .select()
        .from(changelog)
        .where(
          and(
            eq(changelog.sessionId, sessionId),
            eq(changelog.status, "success"),
            isNull(changelog.undoneBy),
          ),
        )
        .orderBy(desc(changelog.id));
      const reversed: number[] = [];
      const failures: { id: number; error: string }[] = [];
      for (const row of candidates) {
        try {
          await reverseOne(row.id);
          reversed.push(row.id);
        } catch (err) {
          failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      res.json({ ok: failures.length === 0, reversed, failures });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

async function reverseOne(id: number): Promise<{ id: number; reversed_by: number }> {
  const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
  if (!row) throw new EntryNotFoundError(id);
  if (row.status !== "success") throw new NotReversibleError(id, `entry status is '${row.status}'`);
  if (row.undoneBy !== null) throw new NotReversibleError(id, `already undone by entry ${row.undoneBy}`);

  const entry = toEntry(row);
  const reversalSessionId = `undo:${row.sessionId}`;
  const [pending] = await db
    .insert(changelog)
    .values({
      caller: "api:changes.undo",
      sessionId: reversalSessionId,
      operation: `${row.operation}.undo`,
      targetKind: row.targetKind,
      targetId: row.targetId,
      intent: `undo of changelog ${row.id}`,
      beforeState: row.afterState as Record<string, unknown>,
      afterState: row.beforeState as Record<string, unknown>,
      externalTarget: row.externalTarget,
      status: "pending",
    })
    .returning({ id: changelog.id });

  try {
    await registry.reverse(entry);
    await db.update(changelog).set({ status: "success" }).where(eq(changelog.id, pending.id));
    await db.update(changelog).set({ undoneBy: pending.id }).where(eq(changelog.id, row.id));
    return { id: row.id, reversed_by: pending.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(changelog)
      .set({ status: "failed", error: message.slice(0, 4000) })
      .where(eq(changelog.id, pending.id));
    throw err;
  }
}

class EntryNotFoundError extends Error {
  constructor(public readonly id: number) {
    super(`changelog entry ${id} not found`);
    this.name = "EntryNotFoundError";
  }
}

class NotReversibleError extends Error {
  constructor(public readonly id: number, message: string) {
    super(`changelog entry ${id} not reversible: ${message}`);
    this.name = "NotReversibleError";
  }
}

function handleError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  if (err instanceof EntryNotFoundError) {
    res.status(404).json({ ok: false, error: err.message, id: err.id });
    return;
  }
  if (err instanceof NotReversibleError) {
    res.status(409).json({ ok: false, error: err.message, id: err.id });
    return;
  }
  if (err instanceof NoReverserError) {
    res.status(409).json({ ok: false, error: err.message, operation: err.operation });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "invalid request", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
