import type { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { rules } from "../db/schema.js";
import { ensureTab, replaceTabData } from "../integrations/google/sheets.js";
import {
  RULES_TAB_HEADERS,
  SITUATIONAL_TAB_HEADERS,
  ruleToSheetRow,
} from "./transaction-rule-sheet.js";
import { TRIAGE_DOMAIN } from "./transaction-triage.js";

export type RuleTabTargets = {
  sheetId: string;
  rulesTab: string;
  situationalTab: string;
};

export type SeedResult = {
  rulesWritten: number;
  situationalWritten: number;
  skipped: number;
};

type MappedRule =
  | { kind: "rule"; value: string; type: "contains" | "equals"; category: string }
  | { kind: "situational"; value: string }
  | null;

/** Pull the token out of a `contains` match, whether bare or wrapped in `any`. */
function extractContainsToken(match: unknown): string | null {
  const m = match as { op?: string; value?: unknown; any?: unknown };
  if (Array.isArray(m?.any)) {
    for (const c of m.any as { op?: string; value?: unknown }[]) {
      if (c?.op === "contains" && typeof c.value === "string" && c.value) return c.value;
    }
  }
  if (m?.op === "contains" && typeof m.value === "string" && m.value) return m.value;
  return null;
}

/**
 * Map a DB rule's match/action onto an HS-tab row. Returns null for shapes the
 * simple sheet schema can't express (complex composite matches), so the caller
 * can count them as skipped rather than lose them silently.
 */
export function dbRuleToSheet(match: unknown, action: unknown): MappedRule {
  const a = action as { situational?: unknown; category?: unknown };
  if (a?.situational === true) {
    const v = extractContainsToken(match);
    return v ? { kind: "situational", value: v } : null;
  }
  const category = typeof a?.category === "string" ? a.category : null;
  if (!category) return null;

  const m = match as { op?: string; field?: string; value?: unknown };
  if (
    m?.op === "equals" &&
    (m.field === "full_description" || m.field === "description") &&
    typeof m.value === "string" &&
    m.value
  ) {
    return { kind: "rule", value: m.value, type: "equals", category };
  }
  const token = extractContainsToken(match);
  return token ? { kind: "rule", value: token, type: "contains", category } : null;
}

export type SheetWriters = {
  ensureTab: typeof ensureTab;
  replaceTabData: typeof replaceTabData;
};

/**
 * One-shot migration: write the current DB transaction rules into our HS Rules
 * and HS Situational tabs (creating them if missing). Idempotent — it replaces
 * the tab contents each run, so re-running just mirrors the DB again. The live
 * app runs this once to seed the sheet; afterwards the sheet is the editable
 * source. Writers are injectable for testing.
 */
export async function seedRuleTabsFromDb(
  client: OAuth2Client,
  targets: RuleTabTargets,
  options: { database?: typeof defaultDb; writers?: SheetWriters } = {},
): Promise<SeedResult> {
  const database = options.database ?? defaultDb;
  const writers = options.writers ?? { ensureTab, replaceTabData };

  const dbRules = await database.select().from(rules).where(eq(rules.domain, TRIAGE_DOMAIN));

  const ruleRows: (string | number | boolean)[][] = [];
  const situationalRows: (string | number | boolean)[][] = [];
  let skipped = 0;

  for (const r of dbRules) {
    const mapped = dbRuleToSheet(r.match, r.action);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    if (mapped.kind === "rule") {
      ruleRows.push(
        ruleToSheetRow({
          match: mapped.value,
          type: mapped.type,
          category: mapped.category,
          priority: r.priority,
          enabled: r.enabled,
          notes: r.notes ?? "",
        }),
      );
    } else {
      situationalRows.push([mapped.value, r.notes ?? ""]);
    }
  }

  await writers.ensureTab(client, targets.sheetId, targets.rulesTab, [...RULES_TAB_HEADERS]);
  await writers.ensureTab(client, targets.sheetId, targets.situationalTab, [
    ...SITUATIONAL_TAB_HEADERS,
  ]);
  await writers.replaceTabData(client, targets.sheetId, targets.rulesTab, [...RULES_TAB_HEADERS], ruleRows);
  await writers.replaceTabData(
    client,
    targets.sheetId,
    targets.situationalTab,
    [...SITUATIONAL_TAB_HEADERS],
    situationalRows,
  );

  return {
    rulesWritten: ruleRows.length,
    situationalWritten: situationalRows.length,
    skipped,
  };
}
