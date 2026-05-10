import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { aiCalls } from "../db/schema.js";

const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  classifier: z.string().min(1).max(200).optional(),
  status: z.enum(["success", "parse_failed", "api_error"]).optional(),
});

const IdParam = z.coerce.number().int().positive();

function rowToJson(row: typeof aiCalls.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    created_at: row.createdAt,
    classifier: row.classifier,
    caller: row.caller,
    model: row.model,
    system_prompt: row.systemPrompt,
    input: row.input,
    raw_output: row.rawOutput,
    parsed_output: row.parsedOutput,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_input_tokens: row.cacheReadInputTokens,
    cache_creation_input_tokens: row.cacheCreationInputTokens,
    effort: row.effort,
    duration_ms: row.durationMs,
    status: row.status,
    error: row.error,
    intent: row.intent,
  };
}

class EntryNotFoundError extends Error {
  constructor(public readonly id: number) {
    super(`ai_calls entry ${id} not found`);
    this.name = "EntryNotFoundError";
  }
}

export function makeAiCallsRouter(): Router {
  const router = Router();

  router.get("/recent", async (req, res) => {
    try {
      const q = RecentQuery.parse(req.query);
      const filters = [
        q.classifier ? eq(aiCalls.classifier, q.classifier) : undefined,
        q.status ? eq(aiCalls.status, q.status) : undefined,
      ].filter((x): x is NonNullable<typeof x> => x !== undefined);
      const where = filters.length > 0 ? and(...filters) : undefined;

      const rows = await db
        .select()
        .from(aiCalls)
        .where(where)
        .orderBy(desc(aiCalls.id))
        .limit(q.limit);
      res.json({ ok: true, count: rows.length, entries: rows.map(rowToJson) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, id));
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
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "invalid request", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
