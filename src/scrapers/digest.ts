/**
 * AI digest generator. Given the most recent N scraper_items for a
 * `kind`, calls Claude to produce a short narrative summary scoped to
 * the user's interests (AI voice agents + competitor activity for
 * ai_news; the specified event categories for events). Persists the
 * result in scraper_digests and links the source item IDs.
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db as defaultDb } from "../db/client.js";
import { scraperDigests, scraperItems } from "../db/schema.js";
import { classify } from "../ai/classify.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import type { ScraperKind } from "../sync/scraper-run.js";

const DigestSchema = z.object({
  summary: z
    .string()
    .min(20)
    .describe(
      "Markdown briefing, 3-6 paragraphs. Group related stories. Lead with the most significant items.",
    ),
});

export type DigestRow = {
  id: number;
  createdAt: Date;
  kind: string;
  periodStart: Date;
  periodEnd: Date;
  itemIds: number[];
  summary: string;
  aiCallId: number | null;
};

export type DigestOptions = {
  kind: ScraperKind;
  caller: string;
  /** Max items to include in the prompt. Default 40. */
  limit?: number;
  database?: typeof defaultDb;
};

const AI_NEWS_SYSTEM = `You produce a concise briefing for a builder working on AI voice agents.
Focus on: voice/audio model releases, agentic capability launches, competitor moves (Anthropic, OpenAI, ElevenLabs, etc.), and policy/enterprise news that affects voice agent deployment.
Skip: routine product updates, hype pieces, opinion essays without new facts.
Output well-formed Markdown.`;

const EVENTS_SYSTEM = `You produce a short events briefing scoped to Richmond, VA-area listings.
Group items by category (karaoke, singles, people of color, interracial, festivals). Lead with the soonest events. Include the date and venue inline. Skip duplicates.
Output well-formed Markdown.`;

function formatItem(item: {
  source: string;
  title: string;
  publishedAt: Date | null;
  rawSnippet: string | null;
  itemUrl: string;
}): string {
  const when = item.publishedAt ? item.publishedAt.toISOString().slice(0, 10) : "undated";
  const snip = item.rawSnippet ? `\n  ${item.rawSnippet.replace(/\s+/g, " ").slice(0, 400)}` : "";
  return `- [${item.source} | ${when}] ${item.title} (${item.itemUrl})${snip}`;
}

export async function generateDigest(opts: DigestOptions): Promise<DigestRow> {
  await enforceConfiguredDailyLimit("scraper.digest.generate");
  const database = opts.database ?? defaultDb;
  const limit = opts.limit ?? 40;

  const recent = await database
    .select({
      id: scraperItems.id,
      source: scraperItems.source,
      title: scraperItems.title,
      publishedAt: scraperItems.publishedAt,
      rawSnippet: scraperItems.rawSnippet,
      itemUrl: scraperItems.itemUrl,
      createdAt: scraperItems.createdAt,
    })
    .from(scraperItems)
    .where(eq(scraperItems.kind, opts.kind))
    .orderBy(desc(scraperItems.createdAt))
    .limit(limit);

  if (recent.length === 0) {
    throw new Error(`no scraper_items for kind="${opts.kind}" — run a scrape first`);
  }

  const periodEnd = recent[0].createdAt;
  const periodStart = recent[recent.length - 1].createdAt;
  const input = recent.map(formatItem).join("\n");

  const { output, callId } = await classify({
    classifier: `scraper.digest.${opts.kind}`,
    caller: opts.caller,
    systemPrompt: opts.kind === "ai_news" ? AI_NEWS_SYSTEM : EVENTS_SYSTEM,
    schema: DigestSchema,
    input,
    effort: "medium",
    intent: `digest ${opts.kind} (${recent.length} items)`,
    maxTokens: 6000,
  });

  const [row] = await database
    .insert(scraperDigests)
    .values({
      kind: opts.kind,
      periodStart,
      periodEnd,
      itemIds: recent.map((r) => r.id),
      summary: output.summary,
      aiCallId: callId,
    })
    .returning();

  return {
    id: row.id,
    createdAt: row.createdAt,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    itemIds: row.itemIds as number[],
    summary: row.summary,
    aiCallId: row.aiCallId,
  };
}
