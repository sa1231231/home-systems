import { Router } from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { scraperDigests, scraperItems } from "../db/schema.js";
import { newSessionId } from "../changelog/index.js";
import { runScraperOnce, type ScraperKind } from "../sync/scraper-run.js";
import { generateDigest } from "../scrapers/digest.js";
import { DailyLimitExceededError } from "../safety/limits.js";
import { getConfig } from "../config.js";

const KindParam = z.object({
  kind: z.enum(["ai_news", "events"]),
});

export function makeScraperRouter(): Router {
  const router = Router();

  router.post("/:kind/run", async (req, res) => {
    try {
      const { kind } = KindParam.parse(req.params);
      const result = await runScraperOnce(kind as ScraperKind, {
        sessionId: req.sessionId ?? newSessionId(),
        caller: `api:scraper.${kind}.run`,
        eventsLocation: getConfig().EVENTS_LOCATION,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/:kind/items", async (req, res) => {
    try {
      const { kind } = KindParam.parse(req.params);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
      const rows = await db
        .select()
        .from(scraperItems)
        .where(eq(scraperItems.kind, kind))
        .orderBy(desc(scraperItems.createdAt))
        .limit(limit);
      res.json({ ok: true, count: rows.length, items: rows });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:kind/digest", async (req, res) => {
    try {
      const { kind } = KindParam.parse(req.params);
      const digest = await generateDigest({
        kind: kind as ScraperKind,
        caller: `api:scraper.${kind}.digest`,
      });
      res.json({ ok: true, digest });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/:kind/digests", async (req, res) => {
    try {
      const { kind } = KindParam.parse(req.params);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const rows = await db
        .select()
        .from(scraperDigests)
        .where(eq(scraperDigests.kind, kind))
        .orderBy(desc(scraperDigests.createdAt))
        .limit(limit);
      res.json({ ok: true, count: rows.length, digests: rows });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
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
