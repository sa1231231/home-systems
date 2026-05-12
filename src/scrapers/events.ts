/**
 * AllEvents.in scraper. Eventbrite is fronted by AWS WAF that gates the
 * search pages behind a CAPTCHA challenge, so a plain HTTP fetch always
 * fails. AllEvents.in serves the same shape of JSON-LD embedded in the
 * search HTML and is currently scraper-friendly.
 *
 * Each search page is `https://allevents.in/<city-slug>/<query-slug>` and
 * embeds `<script type="application/ld+json">` blocks — `@type: "Event"`
 * blocks contain everything we need (name, url, startDate, location,
 * description). Malformed JSON blocks are skipped silently rather than
 * failing the run.
 */

import type { EventCategory } from "./sources.js";

export type EventItem = {
  category: string;
  source: "AllEvents.in";
  url: string;
  title: string;
  startsAt: Date | null;
  location: string | null;
  snippet: string;
};

function slugifyLocation(location: string): string {
  return location
    .toLowerCase()
    .replace(/,/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 1) // AllEvents groups by city only ("richmond"), region tagged separately
    .join("-");
}

function slugifyQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function buildAllEventsUrl(category: EventCategory, location: string): string {
  const city = slugifyLocation(location) || "richmond";
  const q = slugifyQuery(category.query);
  return `https://allevents.in/${city}/${q}`;
}

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stringField(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

function locationOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = stringField(obj, "name");
  const addr = obj.address;
  let addrStr: string | null = null;
  if (typeof addr === "string") addrStr = addr;
  else if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    addrStr = [a.streetAddress, a.addressLocality, a.addressRegion]
      .filter((s) => typeof s === "string" && s)
      .join(", ") || null;
  }
  return [name, addrStr].filter(Boolean).join(" — ") || null;
}

/**
 * Extract events from a search page's HTML by reading every embedded
 * JSON-LD block and keeping `@type: "Event"` entries. Works for both
 * AllEvents.in and any similarly structured source.
 */
export function parseEventsHtml(
  html: string,
  categorySlug: string,
  sourceLabel: "AllEvents.in" = "AllEvents.in",
): EventItem[] {
  const out: EventItem[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const type = (block as Record<string, unknown>)["@type"];
      const isEvent = type === "Event" || (Array.isArray(type) && type.includes("Event"));
      if (!isEvent) continue;
      const ev = block as Record<string, unknown>;
      const url = stringField(ev, "url");
      const title = stringField(ev, "name");
      if (!url || !title) continue;
      out.push({
        category: categorySlug,
        source: sourceLabel,
        url,
        title,
        startsAt: parseDate(ev.startDate),
        location: locationOf(ev.location),
        snippet: stringField(ev, "description")?.slice(0, 600) ?? "",
      });
    }
  }
  return dedupeByUrl(out);
}

function dedupeByUrl(items: EventItem[]): EventItem[] {
  const seen = new Set<string>();
  const out: EventItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

export async function fetchEvents(
  category: EventCategory,
  location: string,
): Promise<EventItem[]> {
  const url = buildAllEventsUrl(category, location);
  const res = await fetch(url, {
    headers: {
      // AllEvents.in returns the same HTML regardless of UA, but using a
      // mainstream browser string keeps us off the bot-filtering fast path.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → ${res.status}`);
  }
  const html = await res.text();
  return parseEventsHtml(html, category.slug);
}
