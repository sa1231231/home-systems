import { describe, expect, it } from "vitest";
import {
  cashflowBars,
  categoryBars,
  escapeHtml,
  fmtUsd,
  merchantBars,
  monthLabel,
  trendLine,
} from "./transaction-charts.js";

describe("fmtUsd", () => {
  it("formats whole-dollar currency", () => {
    expect(fmtUsd(1234.56)).toBe("$1,235");
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(-50)).toBe("-$50");
  });
});

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });
});

describe("monthLabel", () => {
  it("formats a month key", () => {
    expect(monthLabel("2026-11")).toBe("Nov '26");
    expect(monthLabel("2025-01")).toBe("Jan '25");
  });
  it("falls back on bad input", () => {
    expect(monthLabel("junk")).toBe("junk");
  });
});

describe("categoryBars", () => {
  it("renders a bar per category and escapes labels", () => {
    const html = categoryBars([
      { category: "Groceries", total: 200 },
      { category: "<b>Rent</b>", total: 100 },
    ]);
    expect(html).toContain("Groceries");
    expect(html).toContain("&lt;b&gt;Rent&lt;/b&gt;");
    expect(html).not.toContain("<b>Rent</b>");
    // Largest value anchors the 100% bar.
    expect(html).toContain("width:100.0%");
  });

  it("shows an empty state", () => {
    expect(categoryBars([])).toContain("No spending recorded");
  });
});

describe("merchantBars", () => {
  it("includes a repeat-count suffix when count > 1", () => {
    const html = merchantBars([{ merchant: "Amazon", total: 50, count: 3 }]);
    expect(html).toContain("Amazon");
    expect(html).toContain("3×");
  });
});

describe("cashflowBars", () => {
  it("renders an svg with a legend and a rect+title per series", () => {
    const html = cashflowBars([
      { month: "2026-10", income: 3000, expense: 500, net: 2500 },
      { month: "2026-11", income: 3000, expense: 200, net: 2800 },
    ]);
    expect(html).toContain("<svg");
    expect(html).toContain("Income");
    expect(html).toContain("Expense");
    // Apostrophe in the month label is HTML-escaped inside the <title>.
    expect(html).toContain("<title>Oct &#39;26 income: $3,000</title>");
    expect(html).toContain("<title>Nov &#39;26 expense: $200</title>");
  });

  it("shows an empty state", () => {
    expect(cashflowBars([])).toContain("Not enough history");
  });
});

describe("trendLine", () => {
  it("renders a polyline with a dot per month", () => {
    const html = trendLine([
      { month: "2026-09", expense: 400 },
      { month: "2026-10", expense: 500 },
      { month: "2026-11", expense: 300 },
    ]);
    expect(html).toContain("<polyline");
    expect((html.match(/<circle/g) ?? []).length).toBe(3);
  });

  it("needs at least two points", () => {
    expect(trendLine([{ month: "2026-11", expense: 100 }])).toContain("Not enough history");
  });
});
