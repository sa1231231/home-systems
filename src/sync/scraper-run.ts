/**
 * Runs a scrape for a single `kind` ("ai_news" or "events"): fetches
 * every configured source, dedupes against existing rows in
 * `scraper_items` by (kind, item_url), and inserts the new ones. Each
 * insert is wrapped in `withChangelog` so the activity tab can show
 * "fetched N items at HH:MM" sessions with per-session totals.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { scraperItems } from "../db/schema.js";
import { withChangelog } from "../changelog/log.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import { fetchFeed, type FeedItem } from "../scrapers/rss.js";
import { fetchEventbrite, type EventItem } from "../scrapers/events.js";
import { AI_NEWS_SOURCES, EVENT_CATEGORIES } from "../scrapers/sources.js";

export type ScraperKind = "ai_news" | "events";

export type ScraperRunResult = {
  kind: ScraperKind;
  fetched: number;
  inserted: number;
  duplicates: number;
  errors: Array<{ source: string; error: string }>;
  itemIds: number[];
};

export type ScraperRunOptions = {
  sessionId: string;
  caller: string;
  /** Optional override for the events location (defaults to config). */
  eventsLocation?: string;
  /** Inject a different db for tests. */
  database?: typeof defaultDb;
};

type StagedItem = {
  source: string;
  itemUrl: string;
  title: string;
  publishedAt: Date | null;
  rawSnippet: string;
  tags: string[];
};

function stageAiNews(items: FeedItem[]): StagedItem[] {
  const out: StagedItem[] = [];
  for (const i of items) {
    out.push({
      source: i.source,
      itemUrl: i.url,
      title: i.title.slice(0, 500),
      publishedAt: i.publishedAt,
      rawSnippet: i.snippet,
      tags: ["ai_news"],
    });
  }
  return out;
}

function stageEvents(items: EventItem[]): StagedItem[] {
  return items.map((i) => ({
    source: i.source,
    itemUrl: i.url,
    title: i.title.slice(0, 500),
    publishedAt: i.startsAt,
    rawSnippet: i.location ? `${i.location}\n${i.snippet}` : i.snippet,
    tags: [i.category],
  }));
}

async function fetchAiNews(): Promise<{ items: StagedItem[]; errors: ScraperRunResult["errors"] }> {
  const errors: ScraperRunResult["errors"] = [];
  const all: FeedItem[] = [];
  for (const src of AI_NEWS_SOURCES) {
    try {
      const items = await fetchFeed(src.url, src.label);
      const filtered = src.requireMatch
        ? items.filter(
            (i) => src.requireMatch!.test(i.title) || src.requireMatch!.test(i.snippet),
          )
        : items;
      all.push(...filtered);
    } catch (err) {
      errors.push({ source: src.label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { items: stageAiNews(all), errors };
}

async function fetchEvents(
  location: string,
): Promise<{ items: StagedItem[]; errors: ScraperRunResult["errors"] }> {
  const errors: ScraperRunResult["errors"] = [];
  const all: EventItem[] = [];
  for (const cat of EVENT_CATEGORIES) {
    try {
      const events = await fetchEventbrite(cat, location);
      all.push(...events);
    } catch (err) {
      errors.push({
        source: `Eventbrite:${cat.slug}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { items: stageEvents(all), errors };
}

/**
 * Filter `staged` down to URLs not yet present in scraper_items for the
 * given kind. Returns a parallel array of items to insert.
 */
async function filterAlreadyKnown(
  database: typeof defaultDb,
  kind: ScraperKind,
  staged: StagedItem[],
): Promise<StagedItem[]> {
  if (staged.length === 0) return [];
  const urls = staged.map((s) => s.itemUrl);
  const existing = await database
    .select({ url: scraperItems.itemUrl })
    .from(scraperItems)
    .where(and(eq(scraperItems.kind, kind), inArray(scraperItems.itemUrl, urls)));
  const known = new Set(existing.map((e) => e.url));
  return staged.filter((s) => !known.has(s.itemUrl));
}

export async function runScraperOnce(
  kind: ScraperKind,
  opts: ScraperRunOptions,
): Promise<ScraperRunResult> {
  const database = opts.database ?? defaultDb;
  await enforceConfiguredDailyLimit("scraper.fetch");
  const { items: staged, errors } =
    kind === "ai_news" ? await fetchAiNews() : await fetchEvents(opts.eventsLocation ?? "Richmond, VA");

  const fresh = await filterAlreadyKnown(database, kind, staged);
  const duplicates = staged.length - fresh.length;

  const itemIds: number[] = [];
  for (const item of fresh) {
    try {
      const id = await withChangelog(
        {
          caller: opts.caller,
          sessionId: opts.sessionId,
          operation: "scraper.item.insert",
          targetKind: "scraper_item",
          targetId: item.itemUrl,
          intent: `insert ${kind} item from ${item.source}`,
          before: {},
          after: {
            kind,
            source: item.source,
            title: item.title,
            published_at: item.publishedAt?.toISOString() ?? null,
          },
          externalTarget: item.itemUrl,
        },
        async () => {
          await enforceConfiguredDailyLimit("scraper.item.insert");
          const [row] = await database
            .insert(scraperItems)
            .values({
              kind,
              source: item.source,
              itemUrl: item.itemUrl,
              title: item.title,
              publishedAt: item.publishedAt ?? null,
              tags: item.tags,
              rawSnippet: item.rawSnippet || null,
            })
            .returning({ id: scraperItems.id });
          return row.id;
        },
      );
      itemIds.push(id);
    } catch (err) {
      errors.push({
        source: item.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    kind,
    fetched: staged.length,
    inserted: itemIds.length,
    duplicates,
    errors,
    itemIds,
  };
}
