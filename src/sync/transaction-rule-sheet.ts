import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { evaluateCondition, type Cond } from "../rules/dsl.js";

export const DEFAULT_RULES_TAB = "HS Rules";
export const DEFAULT_SITUATIONAL_TAB = "HS Situational";

/**
 * Transaction rules sourced from OUR OWN sheet tabs (never Tiller's auto-filled
 * tabs — see the sheet-tabs invariant). A human edits these tabs directly; this
 * module parses them into the same match/action shapes the rules engine already
 * understands, so evaluation logic stays unchanged.
 */

export type RuleAction = { category: string } | { situational: true };

export type SheetRule = {
  name: string;
  match: Cond;
  action: RuleAction;
  priority: number;
  enabled: boolean;
  /** 1-based sheet row (header is row 1), for write-backs. */
  rowNumber: number;
};

export type RawValues = (string | number | boolean | null)[][];

// Our tab schemas. The first data column is the merchant text; the rest are
// optional and fall back to sensible defaults when blank or absent.
export const RULES_TAB_HEADERS = [
  "Match",
  "Type",
  "Category",
  "Priority",
  "Enabled",
  "Notes",
] as const;
export const SITUATIONAL_TAB_HEADERS = ["Merchant", "Notes"] as const;

/** Category rules match the short OR full description (survives bank suffix noise). */
export function containsMerchant(value: string): Cond {
  const v = value.trim();
  return {
    any: [
      { field: "description", op: "contains", value: v },
      { field: "full_description", op: "contains", value: v },
    ],
  };
}

export function equalsMerchant(value: string): Cond {
  const v = value.trim();
  return {
    any: [
      { field: "description", op: "equals", value: v },
      { field: "full_description", op: "equals", value: v },
    ],
  };
}

export function isSituationalAction(action: RuleAction): action is { situational: true } {
  return (action as { situational?: unknown }).situational === true;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

function cellStr(row: (string | number | boolean | null)[], i: number): string {
  if (i < 0) return "";
  const v = row[i];
  return v == null ? "" : String(v).trim();
}

/** TRUE unless the cell clearly says otherwise. Blank defaults to enabled. */
function parseEnabled(s: string): boolean {
  if (!s) return true;
  return !["false", "0", "no", "n", "off"].includes(s.toLowerCase());
}

/** Parse our "Rules" tab into category rules. Rows missing Match or Category are skipped. */
export function parseRulesTabValues(values: RawValues): SheetRule[] {
  if (values.length < 1) return [];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const matchCol = headerIndex(headers, "Match") >= 0 ? headerIndex(headers, "Match") : 0;
  const col = {
    match: matchCol,
    type: headerIndex(headers, "Type"),
    category: headerIndex(headers, "Category"),
    priority: headerIndex(headers, "Priority"),
    enabled: headerIndex(headers, "Enabled"),
  };
  const out: SheetRule[] = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    const matchVal = cellStr(raw, col.match);
    const category = cellStr(raw, col.category);
    if (!matchVal || !category) continue;
    const type = (cellStr(raw, col.type) || "contains").toLowerCase();
    const match = type === "equals" ? equalsMerchant(matchVal) : containsMerchant(matchVal);
    const priorityRaw = cellStr(raw, col.priority);
    const priority =
      priorityRaw && Number.isFinite(Number(priorityRaw)) ? Number(priorityRaw) : 100;
    out.push({
      name: `rule: ${matchVal.slice(0, 80)}`,
      match,
      action: { category },
      priority,
      enabled: parseEnabled(cellStr(raw, col.enabled)),
      rowNumber: i + 1,
    });
  }
  return out;
}

/** Parse our "Situational" tab into situational-marker rules (always AI review). */
export function parseSituationalTabValues(values: RawValues): SheetRule[] {
  if (values.length < 1) return [];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const mCol = headerIndex(headers, "Merchant") >= 0 ? headerIndex(headers, "Merchant") : 0;
  const out: SheetRule[] = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    const v = cellStr(raw, mCol);
    if (!v) continue;
    out.push({
      name: `situational: ${v.slice(0, 80)}`,
      match: containsMerchant(v),
      action: { situational: true },
      priority: 10,
      enabled: true,
      rowNumber: i + 1,
    });
  }
  return out;
}

export type SheetMatch = { rule: SheetRule; action: RuleAction };

/** Enabled rules, lowest priority number first; sheet order breaks ties (stable sort). */
export function orderRules(rules: SheetRule[]): SheetRule[] {
  return rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
}

/**
 * First enabled rule whose match evaluates true for the subject, by priority
 * then sheet order. Mirrors the DB engine's pickFirstMatch semantics.
 */
export function pickSheetMatch(rules: SheetRule[], subject: unknown): SheetMatch | null {
  for (const rule of orderRules(rules)) {
    if (evaluateCondition(rule.match, subject)) return { rule, action: rule.action };
  }
  return null;
}

/** Read a tab's values, tolerating a missing tab (returns null instead of throwing). */
async function readTabValuesTolerant(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
): Promise<RawValues | null> {
  const sheets = google.sheets({ version: "v4", auth: client });
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A:ZZ`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    return (res.data.values ?? []) as RawValues;
  } catch (err) {
    // A missing tab surfaces as a 400 "Unable to parse range". Treat any read
    // failure as "no sheet rules" so triage falls back to DB rules — never a
    // regression before the tabs are seeded.
    const message = err instanceof Error ? err.message : String(err);
    if (/unable to parse range|not found|400/i.test(message)) return null;
    throw err;
  }
}

/**
 * Load transaction rules from our own HS Rules + HS Situational tabs. Returns an
 * empty list when the tabs are absent/empty — the caller treats empty as "use
 * DB rules instead", so categorization is unchanged until the tabs are seeded.
 */
export async function loadSheetTransactionRules(
  client: OAuth2Client,
  target: { sheetId: string; rulesTab?: string; situationalTab?: string },
): Promise<SheetRule[]> {
  const rulesTab = target.rulesTab ?? DEFAULT_RULES_TAB;
  const situationalTab = target.situationalTab ?? DEFAULT_SITUATIONAL_TAB;
  const [rulesVals, sitVals] = await Promise.all([
    readTabValuesTolerant(client, target.sheetId, rulesTab),
    readTabValuesTolerant(client, target.sheetId, situationalTab),
  ]);
  return [
    ...parseSituationalTabValues(sitVals ?? []),
    ...parseRulesTabValues(rulesVals ?? []),
  ];
}

/** Build a row for appending/promoting a category rule into the Rules tab. */
export function ruleToSheetRow(params: {
  match: string;
  type?: "contains" | "equals";
  category: string;
  priority?: number;
  enabled?: boolean;
  notes?: string;
}): (string | number | boolean)[] {
  return [
    params.match,
    params.type ?? "contains",
    params.category,
    params.priority ?? 100,
    params.enabled === false ? "FALSE" : "TRUE",
    params.notes ?? "",
  ];
}
