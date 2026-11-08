import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { appendRows } from "../integrations/google/sheets.js";

export type RawValues = (string | number | boolean | null)[][];

/**
 * Integration with Tiller's native AutoCat tab, the single rules store. AutoCat
 * is Tiller's own rules sheet: filter columns (e.g. "Description Contains",
 * case-insensitive literal) + override columns ("Category"), applied by Tiller
 * on every fill. We lean on it instead of a parallel rules system:
 *   - Tiller categorizes deterministically on fill.
 *   - Our triage only AI-categorizes the leftovers, then appends an AutoCat rule
 *     so Tiller handles that merchant next time ("auto-teach").
 *
 * The in-app matcher here is only an optimization (so one run doesn't re-AI five
 * identical merchants before Tiller re-runs AutoCat). It deliberately handles
 * ONLY pure "Description/Full Description Contains -> Category" rows and skips
 * anything with other filters (amount, account, regex, catch-alls), so it can
 * never over-apply a rule it doesn't fully understand. Tiller still applies
 * those on fill.
 */

export const AUTOCAT_DEFAULT_TAB = "AutoCat";

export const COL_DESCRIPTION_CONTAINS = "Description Contains";
export const COL_FULL_DESCRIPTION_CONTAINS = "Full Description Contains";
export const COL_CATEGORY = "Category";

export type AutoCatRule = {
  descriptionContains?: string;
  fullDescriptionContains?: string;
  category: string;
  rowNumber: number;
};

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

function cellStr(row: (string | number | boolean | null)[], i: number): string {
  if (i < 0) return "";
  const v = row[i];
  return v == null ? "" : String(v).trim();
}

/**
 * Parse AutoCat rows into the simple contains->category rules we can replicate.
 * A row qualifies only when it has a Category, at least one contains filter, and
 * NO other non-empty cells (so composite rules aren't half-applied).
 */
export function parseAutoCatRules(values: RawValues): AutoCatRule[] {
  if (values.length < 1) return [];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const dcCol = headerIndex(headers, COL_DESCRIPTION_CONTAINS);
  const fdcCol = headerIndex(headers, COL_FULL_DESCRIPTION_CONTAINS);
  const catCol = headerIndex(headers, COL_CATEGORY);
  if (catCol < 0) return [];

  const allowed = new Set([dcCol, fdcCol, catCol].filter((i) => i >= 0));
  const out: AutoCatRule[] = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    const category = cellStr(raw, catCol);
    if (!category) continue;
    const dc = cellStr(raw, dcCol);
    const fdc = cellStr(raw, fdcCol);
    if (!dc && !fdc) continue; // catch-all or non-contains rule — skip in matcher

    // Reject rows that use any other (unsupported) filter/override cell.
    let hasOther = false;
    for (let c = 0; c < raw.length; c++) {
      if (allowed.has(c)) continue;
      if (cellStr(raw, c) !== "") {
        hasOther = true;
        break;
      }
    }
    if (hasOther) continue;

    out.push({
      descriptionContains: dc || undefined,
      fullDescriptionContains: fdc || undefined,
      category,
      rowNumber: i + 1,
    });
  }
  return out;
}

export type AutoCatSubject = { description?: string; full_description?: string };

/** First AutoCat rule matching the subject (top-down), or null. */
export function matchAutoCat(rules: AutoCatRule[], subject: AutoCatSubject): string | null {
  const desc = String(subject.description ?? "").toLowerCase();
  const full = String(subject.full_description ?? "").toLowerCase();
  for (const r of rules) {
    const dcOk = r.descriptionContains ? desc.includes(r.descriptionContains.toLowerCase()) : null;
    const fdcOk = r.fullDescriptionContains
      ? full.includes(r.fullDescriptionContains.toLowerCase())
      : null;
    // Specified filters are ANDed; an unspecified one doesn't constrain.
    const checks = [dcOk, fdcOk].filter((v): v is boolean => v !== null);
    if (checks.length > 0 && checks.every(Boolean)) return r.category;
  }
  return null;
}

/**
 * Build a row aligned to the AutoCat tab's existing header order for appending a
 * new contains->category rule. Throws if the tab lacks the columns we need.
 */
export function buildAutoCatRow(
  headers: string[],
  rule: { descriptionContains?: string; fullDescriptionContains?: string; category: string },
): string[] {
  const catCol = headerIndex(headers, COL_CATEGORY);
  if (catCol < 0) throw new Error(`AutoCat tab has no "${COL_CATEGORY}" column`);
  const dcCol = headerIndex(headers, COL_DESCRIPTION_CONTAINS);
  const fdcCol = headerIndex(headers, COL_FULL_DESCRIPTION_CONTAINS);
  if (rule.descriptionContains && dcCol < 0) {
    throw new Error(`AutoCat tab has no "${COL_DESCRIPTION_CONTAINS}" column`);
  }
  if (rule.fullDescriptionContains && fdcCol < 0) {
    throw new Error(`AutoCat tab has no "${COL_FULL_DESCRIPTION_CONTAINS}" column`);
  }
  const row = new Array<string>(headers.length).fill("");
  if (rule.descriptionContains) row[dcCol] = rule.descriptionContains;
  if (rule.fullDescriptionContains) row[fdcCol] = rule.fullDescriptionContains;
  row[catCol] = rule.category;
  return row;
}

/** Dedupe key for a contains->category rule (case-insensitive). */
export function autoCatRuleKey(rule: {
  descriptionContains?: string;
  fullDescriptionContains?: string;
  category: string;
}): string {
  return [
    (rule.descriptionContains ?? "").toLowerCase(),
    (rule.fullDescriptionContains ?? "").toLowerCase(),
    rule.category.toLowerCase(),
  ].join("\u0000");
}

export type AutoCatCandidate = {
  descriptionContains?: string;
  fullDescriptionContains?: string;
  category: string;
};

export type AutoCatTab = { headers: string[]; rules: AutoCatRule[]; raw: RawValues };

/** Read the AutoCat tab. Returns null if the tab is absent (so callers fall back). */
export async function readAutoCat(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
): Promise<AutoCatTab | null> {
  const sheets = google.sheets({ version: "v4", auth: client });
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A:ZZ`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const raw = (res.data.values ?? []) as RawValues;
    const headers = (raw[0] ?? []).map((h) => String(h ?? "").trim());
    return { headers, rules: parseAutoCatRules(raw), raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unable to parse range|not found|400/i.test(message)) return null;
    throw err;
  }
}

/** Existing contains->category keys in the tab, for append dedupe. */
export function autoCatExistingKeys(raw: RawValues): Set<string> {
  const keys = new Set<string>();
  if (raw.length < 1) return keys;
  const headers = (raw[0] ?? []).map((h) => String(h ?? "").trim());
  const dcCol = headerIndex(headers, COL_DESCRIPTION_CONTAINS);
  const fdcCol = headerIndex(headers, COL_FULL_DESCRIPTION_CONTAINS);
  const catCol = headerIndex(headers, COL_CATEGORY);
  if (catCol < 0) return keys;
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const category = cellStr(row, catCol);
    if (!category) continue;
    const dc = cellStr(row, dcCol);
    const fdc = cellStr(row, fdcCol);
    if (!dc && !fdc) continue;
    keys.add(
      autoCatRuleKey({
        descriptionContains: dc || undefined,
        fullDescriptionContains: fdc || undefined,
        category,
      }),
    );
  }
  return keys;
}

/** Append contains->category rules to the AutoCat tab, aligned to its headers. */
export async function appendAutoCatRules(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
  headers: string[],
  candidates: AutoCatCandidate[],
): Promise<number> {
  const rows = candidates.map((c) => buildAutoCatRow(headers, c));
  if (rows.length === 0) return 0;
  await appendRows(client, spreadsheetId, tab, rows);
  return rows.length;
}

/**
 * Map a DB rule's match/action to an AutoCat contains rule for migration.
 * equals and contains both become a "Description Contains" token (a slight,
 * harmless broadening for merchant text). Situational rules have no AutoCat
 * equivalent (the point is "no rule"), so they map to null.
 */
export function dbRuleToAutoCat(match: unknown, action: unknown): AutoCatCandidate | null {
  const a = action as { situational?: unknown; category?: unknown };
  if (a?.situational === true) return null;
  const category = typeof a?.category === "string" ? a.category : null;
  if (!category) return null;

  const m = match as { op?: string; field?: string; value?: unknown; any?: unknown };
  if (m?.op === "equals" && typeof m.value === "string" && m.value) {
    return { descriptionContains: m.value, category };
  }
  if (m?.op === "contains" && typeof m.value === "string" && m.value) {
    return { descriptionContains: m.value, category };
  }
  if (Array.isArray(m?.any)) {
    for (const c of m.any as { op?: string; value?: unknown }[]) {
      if (c?.op === "contains" && typeof c.value === "string" && c.value) {
        return { descriptionContains: c.value, category };
      }
    }
  }
  return null;
}
