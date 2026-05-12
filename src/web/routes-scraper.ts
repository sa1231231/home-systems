import { Router } from "express";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog, scraperDigests, scraperItems } from "../db/schema.js";
import { newSessionId } from "../changelog/index.js";
import { runScraperOnce, type ScraperKind } from "../sync/scraper-run.js";
import { generateDigest } from "../scrapers/digest.js";
import { DailyLimitExceededError } from "../safety/limits.js";
import { getConfig } from "../config.js";
import { groupBySession } from "./session-groups.js";

const KINDS: ScraperKind[] = ["ai_news", "events"];

function isScraperKind(v: string): v is ScraperKind {
  return (KINDS as string[]).includes(v);
}

async function loadScraperContext() {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const [aiItems, eventItems, aiDigests, eventDigests, activity] = await Promise.all([
    db
      .select()
      .from(scraperItems)
      .where(eq(scraperItems.kind, "ai_news"))
      .orderBy(desc(scraperItems.createdAt))
      .limit(40),
    db
      .select()
      .from(scraperItems)
      .where(eq(scraperItems.kind, "events"))
      .orderBy(desc(scraperItems.createdAt))
      .limit(40),
    db
      .select()
      .from(scraperDigests)
      .where(eq(scraperDigests.kind, "ai_news"))
      .orderBy(desc(scraperDigests.createdAt))
      .limit(5),
    db
      .select()
      .from(scraperDigests)
      .where(eq(scraperDigests.kind, "events"))
      .orderBy(desc(scraperDigests.createdAt))
      .limit(5),
    db
      .select()
      .from(changelog)
      .where(and(like(changelog.operation, "scraper.%"), gte(changelog.createdAt, since)))
      .orderBy(desc(changelog.id))
      .limit(500),
  ]);
  return {
    aiItems,
    eventItems,
    aiDigests,
    eventDigests,
    sessionGroups: groupBySession(activity).slice(0, 30),
    eventsLocation: getConfig().EVENTS_LOCATION,
  };
}

export function makeScraperUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const ctx = await loadScraperContext();
    res.render("scraper", { flash: null, ...ctx });
  });

  router.post("/:kind/run", async (req, res) => {
    const kind = req.params.kind;
    if (!isScraperKind(kind)) {
      res.status(400).send(`<div class="flash err">Unknown scraper kind: ${kind}</div>`);
      return;
    }
    try {
      const result = await runScraperOnce(kind, {
        sessionId: req.sessionId ?? newSessionId(),
        caller: `ui:scraper.${kind}.run`,
        eventsLocation: getConfig().EVENTS_LOCATION,
      });
      const errs = result.errors.length;
      res.setHeader("HX-Refresh", "true");
      const klass = errs > 0 ? "err" : "ok";
      res.send(
        `<div class="flash ${klass}">Scrape: ${result.inserted} new, ${result.duplicates} dup, ${result.fetched} fetched${errs ? `, ${errs} errors` : ""}.</div>`,
      );
    } catch (err) {
      respondError(err, res);
    }
  });

  router.post("/:kind/digest", async (req, res) => {
    const kind = req.params.kind;
    if (!isScraperKind(kind)) {
      res.status(400).send(`<div class="flash err">Unknown scraper kind: ${kind}</div>`);
      return;
    }
    try {
      await generateDigest({
        kind,
        caller: `ui:scraper.${kind}.digest`,
      });
      res.setHeader("HX-Refresh", "true");
      res.send(`<div class="flash ok">Digest generated.</div>`);
    } catch (err) {
      respondError(err, res);
    }
  });

  return router;
}

function respondError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  if (err instanceof DailyLimitExceededError) {
    res.status(429).send(`<div class="flash err">Daily limit: ${escapeHtml(err.message)}</div>`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).send(`<div class="flash err">${escapeHtml(message)}</div>`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
