import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { processedEmails } from "../db/schema.js";
import { MissingGoogleCredsError, requireGoogleCreds } from "../integrations/google/oauth.js";
import { triageAllAccounts } from "../sync/email-triage.js";
import { MissingAnthropicKeyError } from "../ai/index.js";
import { DailyLimitExceededError } from "../safety/limits.js";

const TriageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  dry_run: z.coerce.boolean().default(false),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  outcome: z.enum(["matched_rule", "needs_review", "skipped", "error"]).optional(),
});

function processedRowToJson(row: typeof processedEmails.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    account: row.account,
    thread_id: row.threadId,
    first_seen_at: row.firstSeenAt,
    last_processed_at: row.lastProcessedAt,
    outcome: row.outcome,
    outcome_id: row.outcomeId,
    error: row.error,
  };
}

export function makeEmailsRouter(): Router {
  const router = Router();

  router.post("/triage", async (req, res) => {
    try {
      const { limit, dry_run } = TriageQuery.parse(req.query);
      requireGoogleCreds();
      const summary = await triageAllAccounts({
        limit,
        dryRun: dry_run,
        sessionId: req.sessionId,
        caller: dry_run ? "api:emails.triage:dry-run" : "api:emails.triage",
      });
      res.json({ ok: true, dry_run, ...summary });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/processed", async (req, res) => {
    try {
      const q = ListQuery.parse(req.query);
      const filters = [q.outcome ? eq(processedEmails.outcome, q.outcome) : undefined].filter(
        (x): x is NonNullable<typeof x> => x !== undefined,
      );
      const where = filters.length > 0 ? and(...filters) : undefined;
      const rows = await db
        .select()
        .from(processedEmails)
        .where(where)
        .orderBy(desc(processedEmails.lastProcessedAt))
        .limit(q.limit);
      res.json({ ok: true, count: rows.length, entries: rows.map(processedRowToJson) });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  if (err instanceof MissingGoogleCredsError) {
    res.status(503).json({ ok: false, error: err.message });
    return;
  }
  if (err instanceof MissingAnthropicKeyError) {
    res.status(503).json({ ok: false, error: err.message });
    return;
  }
  if (err instanceof DailyLimitExceededError) {
    res.status(429).json({
      ok: false,
      error: err.message,
      operation: err.operation,
      count: err.count,
      limit: err.limit,
      day: err.day,
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "invalid request", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
