import { describe, expect, it } from "vitest";
import { buildEventbriteUrl, parseEventbriteHtml } from "./events.js";

const sampleHtml = `
<html><head>
  <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Karaoke Night at The Camel",
      "url": "https://www.eventbrite.com/e/karaoke-1",
      "startDate": "2026-05-20T20:00:00-04:00",
      "location": {
        "@type": "Place",
        "name": "The Camel",
        "address": { "streetAddress": "1621 W Broad St", "addressLocality": "Richmond", "addressRegion": "VA" }
      },
      "description": "Open mic followed by karaoke until late"
    }
  </script>
  <script type="application/ld+json">
    [
      {
        "@type": "Event",
        "name": "Festival of the Lakes",
        "url": "https://www.eventbrite.com/e/fest-2",
        "startDate": "2026-06-01T12:00:00-04:00"
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": []
      }
    ]
  </script>
  <script type="application/ld+json">{ this is not valid json }</script>
</head></html>`;

describe("parseEventbriteHtml", () => {
  it("extracts Event entries from JSON-LD blocks", () => {
    const items = parseEventbriteHtml(sampleHtml, "karaoke");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      category: "karaoke",
      source: "Eventbrite",
      url: "https://www.eventbrite.com/e/karaoke-1",
      title: "Karaoke Night at The Camel",
      location: "The Camel — 1621 W Broad St, Richmond, VA",
      snippet: "Open mic followed by karaoke until late",
    });
    expect(items[0].startsAt?.toISOString()).toBe("2026-05-21T00:00:00.000Z");
  });

  it("ignores non-Event JSON-LD types and malformed blocks", () => {
    const items = parseEventbriteHtml(sampleHtml, "karaoke");
    expect(items.find((i) => i.title.includes("Breadcrumb"))).toBeUndefined();
    expect(items).toHaveLength(2);
  });

  it("dedupes events that appear in multiple blocks", () => {
    const dup = sampleHtml + sampleHtml;
    const items = parseEventbriteHtml(dup, "karaoke");
    expect(items).toHaveLength(2);
  });

  it("returns [] for HTML with no events", () => {
    expect(parseEventbriteHtml("<html></html>", "x")).toEqual([]);
  });
});

describe("buildEventbriteUrl", () => {
  it("slugifies a city + state location", () => {
    const url = buildEventbriteUrl(
      { slug: "karaoke", label: "Karaoke", query: "karaoke" },
      "Richmond, VA",
    );
    expect(url).toBe("https://www.eventbrite.com/d/richmond-va/karaoke/");
  });

  it("URL-encodes multi-word query terms", () => {
    const url = buildEventbriteUrl(
      { slug: "poc", label: "POC", query: "people of color" },
      "Richmond, VA",
    );
    expect(url).toBe("https://www.eventbrite.com/d/richmond-va/people%20of%20color/");
  });

  it("falls back to no-location path when location is empty", () => {
    const url = buildEventbriteUrl(
      { slug: "festivals", label: "Festivals", query: "festival" },
      "",
    );
    expect(url).toBe("https://www.eventbrite.com/d/festival/");
  });
});
