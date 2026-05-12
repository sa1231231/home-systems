/**
 * Eventbrite scraper. Uses the public search HTML page — Eventbrite
 * embeds JSON-LD `<script type="application/ld+json">` blocks describing
 * every event card on the result page. No API key required. (If
 * EVENTBRITE_API_KEY is ever set, a future revision can route through
 * the v3 API instead.)
 *
 * The parser is intentionally tolerant: Eventbrite's markup shifts, and
 * any malformed JSON block is skipped rather than failing the whole run.
 */

import type { EventCategory } from "./sources.js";

export type EventItem = {
  category: string;
  source: "Eventbrite";
  url: string;
  title: string;
  startsAt: Date | null;
  location: string | null;
  snippet: string;
};

export function buildEventbriteUrl(category: EventCategory, location: string): string {
  const loc = location
    .toLowerCase()
    .replace(/,/g, "")
    .trim()
    .replace(/\s+/g, "-");
  const slug = loc ? `${loc}/` : "";
  return `https://www.eventbrite.com/d/${slug}${encodeURIComponent(category.query)}/`;
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
 * Extract Eventbrite events from a search page's HTML by reading every
 * embedded JSON-LD block and keeping the ones with `@type: "Event"`.
 */
export function parseEventbriteHtml(html: string, categorySlug: string): EventItem[] {
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
        source: "Eventbrite",
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

export async function fetchEventbrite(
  category: EventCategory,
  location: string,
): Promise<EventItem[]> {
  const url = buildEventbriteUrl(category, location);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; home-systems-scraper/1.0; +https://github.com)",
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → ${res.status}`);
  }
  const html = await res.text();
  return parseEventbriteHtml(html, category.slug);
}
