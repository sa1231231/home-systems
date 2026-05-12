/**
 * Declarative source registry for the scraper. v1 is hardcoded — no
 * settings UI. Add a feed here and it shows up on the next scrape run.
 *
 * `kind` discriminates the source family and matches `scraper_items.kind`.
 */

export type AiNewsSource = {
  label: string;
  url: string;
  /** Optional regex to require in title or snippet (case-insensitive). */
  requireMatch?: RegExp;
};

export type EventCategory = {
  /** Short slug used in the scrape URL and the item tag. */
  slug: string;
  /** Display label. */
  label: string;
  /**
   * Free-text search terms. Eventbrite's HTML search endpoint accepts
   * `?q=...` so this lets us scope without paying for the API.
   */
  query: string;
};

export const AI_NEWS_SOURCES: AiNewsSource[] = [
  { label: "Anthropic", url: "https://www.anthropic.com/news/rss.xml" },
  { label: "OpenAI", url: "https://openai.com/blog/rss.xml" },
  { label: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { label: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { label: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  {
    label: "Hacker News",
    url: "https://hnrss.org/frontpage?q=AI+OR+LLM+OR+%22voice+agent%22&points=50",
    requireMatch: /\b(ai|llm|gpt|claude|voice agent|agentic|model)\b/i,
  },
];

export const EVENT_CATEGORIES: EventCategory[] = [
  { slug: "karaoke", label: "Karaoke", query: "karaoke" },
  { slug: "singles", label: "Singles", query: "singles" },
  { slug: "people-of-color", label: "People of Color", query: "people of color" },
  { slug: "interracial", label: "Interracial", query: "interracial" },
  { slug: "festivals", label: "Festivals", query: "festival" },
];
