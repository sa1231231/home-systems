import { describe, expect, it } from "vitest";
import { buildAllEventsUrl, parseEventsHtml } from "./events.js";

const sampleHtml = `
<html><head>
  <script type="application/ld+json">
    {
      "@type": "Event",
      "name": "Karaoke Night at The Camel",
      "url": "https://allevents.in/richmond/karaoke-1",
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
        "url": "https://allevents.in/richmond/fest-2",
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

describe("parseEventsHtml", () => {
  it("extracts Event entries from JSON-LD blocks", () => {
    const items = parseEventsHtml(sampleHtml, "karaoke");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      category: "karaoke",
      source: "AllEvents.in",
      url: "https://allevents.in/richmond/karaoke-1",
      title: "Karaoke Night at The Camel",
      location: "The Camel — 1621 W Broad St, Richmond, VA",
      snippet: "Open mic followed by karaoke until late",
    });
    expect(items[0].startsAt?.toISOString()).toBe("2026-05-21T00:00:00.000Z");
  });

  it("ignores non-Event JSON-LD types and malformed blocks", () => {
    const items = parseEventsHtml(sampleHtml, "karaoke");
    expect(items.find((i) => i.title.includes("Breadcrumb"))).toBeUndefined();
    expect(items).toHaveLength(2);
  });

  it("dedupes events that appear in multiple blocks", () => {
    const dup = sampleHtml + sampleHtml;
    const items = parseEventsHtml(dup, "karaoke");
    expect(items).toHaveLength(2);
  });

  it("returns [] for HTML with no events", () => {
    expect(parseEventsHtml("<html></html>", "x")).toEqual([]);
  });
});

describe("buildAllEventsUrl", () => {
  it("uses city-only slug from a city + state location", () => {
    const url = buildAllEventsUrl(
      { slug: "karaoke", label: "Karaoke", query: "karaoke" },
      "Richmond, VA",
    );
    expect(url).toBe("https://allevents.in/richmond/karaoke");
  });

  it("hyphenates multi-word queries", () => {
    const url = buildAllEventsUrl(
      { slug: "poc", label: "POC", query: "people of color" },
      "Richmond, VA",
    );
    expect(url).toBe("https://allevents.in/richmond/people-of-color");
  });

  it("defaults to richmond when location is empty", () => {
    const url = buildAllEventsUrl(
      { slug: "festivals", label: "Festivals", query: "festival" },
      "",
    );
    expect(url).toBe("https://allevents.in/richmond/festival");
  });
});
