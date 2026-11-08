import type {
  CategorySpend,
  MerchantSpend,
  MonthCashflow,
  MonthSpend,
} from "../sync/transaction-analytics.js";

// Chart colors harmonize with the app's CSS tokens (see _header.ejs). Income and
// expense use amber/blue rather than a red/green pair so they stay legible for
// colorblind viewers; identity is always reinforced by a legend and labels.
const COLOR_ACCENT = "#0b5fff"; // --accent
const COLOR_INCOME = "#128a3e"; // --ok (income, up)
const COLOR_EXPENSE = "#b35a00"; // --warn (expense)

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function fmtUsd(n: number): string {
  return usd.format(Math.round(n));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "2026-11" -> "Nov '26". Falls back to the raw key if unparseable. */
export function monthLabel(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (!m) return key;
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const idx = Number(m[2]) - 1;
  const name = names[idx] ?? m[2];
  return `${name} '${m[1].slice(2)}`;
}

/** Horizontal CSS bars for a single magnitude series (category/merchant spend). */
export function horizontalBars(
  items: { label: string; value: number; count?: number }[],
  emptyText: string,
): string {
  if (items.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  const rows = items
    .map((i) => {
      const pct = Math.max((i.value / max) * 100, 1).toFixed(1);
      const countSuffix = i.count && i.count > 1 ? ` · ${i.count}×` : "";
      const title = `${i.label}: ${fmtUsd(i.value)}${countSuffix}`;
      return `<div class="chart-bar-row" title="${escapeHtml(title)}">
      <div class="chart-bar-label">${escapeHtml(i.label)}</div>
      <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${pct}%;background:${COLOR_ACCENT};"></div></div>
      <div class="chart-bar-value">${fmtUsd(i.value)}<span class="muted">${escapeHtml(countSuffix)}</span></div>
    </div>`;
    })
    .join("\n");
  return `<div class="chart-bars">${rows}</div>`;
}

export function categoryBars(items: CategorySpend[]): string {
  return horizontalBars(
    items.map((c) => ({ label: c.category, value: c.total })),
    "No spending recorded this month yet.",
  );
}

export function merchantBars(items: MerchantSpend[]): string {
  return horizontalBars(
    items.map((m) => ({ label: m.merchant, value: m.total, count: m.count })),
    "No merchants with spending this month yet.",
  );
}

/** Grouped vertical SVG bars: income vs expense per month, with a legend. */
export function cashflowBars(months: MonthCashflow[]): string {
  if (months.length === 0) return `<p class="muted">Not enough history yet.</p>`;
  const W = 720;
  const H = 220;
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...months.flatMap((m) => [m.income, m.expense]), 1);
  const groupW = plotW / months.length;
  const barW = Math.min(groupW / 3, 26);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const marks = months
    .map((m, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const incX = cx - barW - 1;
      const expX = cx + 1;
      const incBar = `<rect x="${incX.toFixed(1)}" y="${y(m.income).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - y(m.income)).toFixed(1)}" rx="2" fill="${COLOR_INCOME}"><title>${escapeHtml(monthLabel(m.month))} income: ${fmtUsd(m.income)}</title></rect>`;
      const expBar = `<rect x="${expX.toFixed(1)}" y="${y(m.expense).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - y(m.expense)).toFixed(1)}" rx="2" fill="${COLOR_EXPENSE}"><title>${escapeHtml(monthLabel(m.month))} expense: ${fmtUsd(m.expense)}</title></rect>`;
      const label = `<text x="${cx.toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="#666">${escapeHtml(monthLabel(m.month))}</text>`;
      return incBar + expBar + label;
    })
    .join("\n");

  const baseline = `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#ddd" stroke-width="1"/>`;
  const maxLabel = `<text x="${padL - 6}" y="${padT + 10}" text-anchor="end" font-size="11" fill="#666">${fmtUsd(max)}</text>`;
  const legend = `<div class="chart-legend">
    <span><span class="chart-swatch" style="background:${COLOR_INCOME}"></span>Income</span>
    <span><span class="chart-swatch" style="background:${COLOR_EXPENSE}"></span>Expense</span>
  </div>`;

  return `${legend}<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Income vs expense by month">${baseline}${maxLabel}${marks}</svg>`;
}

/** Single-series SVG line: expense per month over time. */
export function trendLine(months: MonthSpend[]): string {
  if (months.length < 2) return `<p class="muted">Not enough history for a trend yet.</p>`;
  const W = 720;
  const H = 200;
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...months.map((m) => m.expense), 1);
  const stepX = months.length > 1 ? plotW / (months.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const points = months.map((m, i) => `${x(i).toFixed(1)},${y(m.expense).toFixed(1)}`).join(" ");
  const dots = months
    .map(
      (m, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(m.expense).toFixed(1)}" r="3.5" fill="${COLOR_ACCENT}"><title>${escapeHtml(monthLabel(m.month))}: ${fmtUsd(m.expense)}</title></circle>`,
    )
    .join("\n");
  const labels = months
    .map(
      (m, i) =>
        `<text x="${x(i).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="#666">${escapeHtml(monthLabel(m.month))}</text>`,
    )
    .join("\n");
  const baseline = `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#ddd" stroke-width="1"/>`;
  const maxLabel = `<text x="${padL - 6}" y="${padT + 10}" text-anchor="end" font-size="11" fill="#666">${fmtUsd(max)}</text>`;
  const line = `<polyline points="${points}" fill="none" stroke="${COLOR_ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Spending trend by month">${baseline}${maxLabel}${line}${dots}${labels}</svg>`;
}
