import { describe, expect, it } from "vitest";
import { parseFeed } from "./rss.js";

describe("parseFeed", () => {
  it("parses an RSS 2.0 feed with <item> blocks", () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <title>Example</title>
        <item>
          <title>First post</title>
          <link>https://example.com/a</link>
          <description>Hello &amp; goodbye</description>
          <pubDate>Tue, 11 May 2026 12:00:00 GMT</pubDate>
        </item>
        <item>
          <title><![CDATA[Second <b>post</b>]]></title>
          <link>https://example.com/b</link>
          <description>Other</description>
        </item>
      </channel></rss>`;
    const items = parseFeed(xml, "Example");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "Example",
      title: "First post",
      url: "https://example.com/a",
      snippet: "Hello & goodbye",
    });
    expect(items[0].publishedAt?.toISOString()).toBe("2026-05-11T12:00:00.000Z");
    expect(items[1].title).toBe("Second post");
  });

  it("parses an Atom feed with <entry> + <link href=>", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Atom one</title>
          <link href="https://atom.example/x" />
          <summary>An entry</summary>
          <updated>2026-05-10T09:00:00Z</updated>
        </entry>
      </feed>`;
    const items = parseFeed(xml, "Atom");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "Atom",
      title: "Atom one",
      url: "https://atom.example/x",
      snippet: "An entry",
    });
    expect(items[0].publishedAt?.toISOString()).toBe("2026-05-10T09:00:00.000Z");
  });

  it("strips HTML tags from descriptions", () => {
    const xml = `<rss><channel><item>
      <title>T</title>
      <link>https://x/y</link>
      <description><![CDATA[<p>Para with <b>bold</b></p>]]></description>
    </item></channel></rss>`;
    expect(parseFeed(xml, "x")[0].snippet).toBe("Para with bold");
  });

  it("skips items missing a title or url", () => {
    const xml = `<rss><channel>
      <item><title>No url</title></item>
      <item><link>https://only-url/</link></item>
    </channel></rss>`;
    expect(parseFeed(xml, "x")).toEqual([]);
  });
});
