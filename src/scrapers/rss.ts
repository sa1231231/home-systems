/**
 * Minimal RSS / Atom feed parser. No external dep — just `fetch` + a few
 * regex extractions. Enough for AI-news source feeds where the shape is
 * predictable. Caller is responsible for further filtering / dedup.
 */

export type FeedItem = {
  source: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  /** First ~600 chars of description/summary; safe-for-display plain text. */
  snippet: string;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripTags(s: string): string {
  return s
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  return stripCdata(m[1]).trim();
}

function pickAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["']`, "i");
  const m = re.exec(xml);
  return m ? m[1] : null;
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function snippetOf(raw: string | null): string {
  if (!raw) return "";
  return stripTags(stripCdata(raw)).slice(0, 600);
}

export function parseFeed(xml: string, sourceLabel: string): FeedItem[] {
  // Try RSS <item> first, then Atom <entry>.
  const itemBlocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const items: FeedItem[] = [];
  for (const block of itemBlocks) {
    const title = decodeEntities(stripTags(pick(block, "title") ?? "")).trim();
    if (!title) continue;
    // RSS uses <link>URL</link>; Atom uses <link href="URL"/>.
    let url = pick(block, "link") ?? "";
    if (!url || /^<link\b/.test(url)) url = pickAttr(block, "link", "href") ?? "";
    if (!url) url = pickAttr(block, "link", "href") ?? "";
    if (!url) continue;
    const description = pick(block, "description") ?? pick(block, "summary") ?? pick(block, "content");
    const pub = pick(block, "pubDate") ?? pick(block, "published") ?? pick(block, "updated");
    items.push({
      source: sourceLabel,
      url: decodeEntities(url.trim()),
      title,
      publishedAt: parseDate(pub),
      snippet: decodeEntities(snippetOf(description)),
    });
  }
  return items;
}

export async function fetchFeed(url: string, sourceLabel: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "home-systems-scraper/1.0 (+https://github.com)" },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → ${res.status}`);
  }
  const xml = await res.text();
  return parseFeed(xml, sourceLabel);
}
