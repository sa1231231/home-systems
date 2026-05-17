import type { OAuth2Client } from "google-auth-library";
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { rules } from "../db/schema.js";
import {
  readCategoriesEnum,
  readTransactionsSheet,
  type TransactionRow,
} from "../integrations/google/sheets-transactions.js";
import { isSituational, type RuleRow } from "../rules/engine.js";
import type { TransactionTarget } from "./transaction-actions.js";
import { TRIAGE_DOMAIN } from "./transaction-triage.js";

export type InferRulesResult = {
  /** New rules created this run. */
  created: number;
  /** Same description key carried two or more *different* canonical categories — skipped. */
  ambiguous: number;
  /** A rule already exists for this description key — skipped. */
  already_exists: number;
  /** Row had a category but it wasn't one of the canonical enum values (Tiller/Yodlee leftover). */
  tiller_skipped: number;
  /** Row had no Category populated at all. */
  empty_skipped: number;
  /** Row was eligible but had no description / full description to key on. */
  no_key_skipped: number;
  /** Distinct (description, category) groups that ended up creating a rule or were ambiguous. */
  groups_examined: number;
  /** New rule rows inserted into the DB, with details. */
  created_rules: Array<{ id: number; field: "full_description" | "description"; value: string; category: string }>;
};

type Group = {
  key: string;
  field: "full_description" | "description";
  categories: Set<string>;
};

function descriptionKey(row: TransactionRow): { key: string; field: "full_description" | "description" } | null {
  const full = (row.fullDescription ?? "").trim();
  if (full) return { key: full, field: "full_description" };
  const desc = (row.description ?? "").trim();
  if (desc) return { key: desc, field: "description" };
  return null;
}

/**
 * Build a Set of description values already covered by an existing
 * domain="transaction" rule whose match is an exact-equals on
 * full_description or description. Used to skip duplicate inserts.
 */
async function loadExistingDescriptionKeys(database: typeof defaultDb): Promise<Set<string>> {
  const existing = await database.select().from(rules).where(eq(rules.domain, TRIAGE_DOMAIN));
  const keys = new Set<string>();
  for (const r of existing) {
    const m = r.match as { op?: string; field?: string; value?: unknown } | null;
    if (!m || m.op !== "equals") continue;
    if (m.field !== "full_description" && m.field !== "description") continue;
    if (typeof m.value === "string" && m.value) keys.add(m.value);
  }
  return keys;
}

/**
 * Scan the live Transactions sheet and create domain="transaction" rules for
 * every (description → canonical category) pairing the user has already
 * recorded. Skips rows whose Category isn't in the canonical enum (Tiller's
 * pre-classifications), descriptions with conflicting categories, and
 * descriptions already covered by an existing rule.
 */
export async function inferTransactionRules(
  client: OAuth2Client,
  target: TransactionTarget,
  options: { database?: typeof defaultDb } = {},
): Promise<InferRulesResult> {
  const database = options.database ?? defaultDb;
  const [tab, enumValues] = await Promise.all([
    readTransactionsSheet(client, target.sheetId, target.transactionsTab),
    readCategoriesEnum(client, target.sheetId, target.categoriesTab),
  ]);
  const canonical = new Set(enumValues);
  const existingKeys = await loadExistingDescriptionKeys(database);

  const result: InferRulesResult = {
    created: 0,
    ambiguous: 0,
    already_exists: 0,
    tiller_skipped: 0,
    empty_skipped: 0,
    no_key_skipped: 0,
    groups_examined: 0,
    created_rules: [],
  };

  const groups = new Map<string, Group>();
  for (const row of tab.rows) {
    const cat = (row.category ?? "").trim();
    if (!cat) {
      result.empty_skipped++;
      continue;
    }
    if (!canonical.has(cat)) {
      result.tiller_skipped++;
      continue;
    }
    const desc = descriptionKey(row);
    if (!desc) {
      result.no_key_skipped++;
      continue;
    }
    let g = groups.get(desc.key);
    if (!g) {
      g = { key: desc.key, field: desc.field, categories: new Set() };
      groups.set(desc.key, g);
    }
    g.categories.add(cat);
  }

  for (const group of groups.values()) {
    result.groups_examined++;
    if (group.categories.size > 1) {
      result.ambiguous++;
      continue;
    }
    if (existingKeys.has(group.key)) {
      result.already_exists++;
      continue;
    }
    const [category] = [...group.categories];
    const [row] = await database
      .insert(rules)
      .values({
        domain: TRIAGE_DOMAIN,
        name: `auto: ${group.key.slice(0, 80)}`,
        match: { op: "equals", field: group.field, value: group.key } as never,
        action: { category, reasoning: "bootstrapped from existing sheet category" } as never,
        priority: 100,
        enabled: true,
        createdBy: "bootstrap",
      })
      .returning({ id: rules.id });
    result.created++;
    result.created_rules.push({ id: row.id, field: group.field, value: group.key, category });
    existingKeys.add(group.key); // guard against same key inserted twice in one run
  }

  return result;
}

/**
 * A "merchant contains" match: fires when `value` (a lowercased token like
 * "amazon") is a substring of the short OR full description. This survives
 * the per-transaction suffix noise banks add ("AMZN MKTP US*2H4…").
 */
export function containsMerchantMatch(value: string): unknown {
  const v = value.trim();
  return {
    any: [
      { op: "contains", field: "description", value: v },
      { op: "contains", field: "full_description", value: v },
    ],
  };
}

/**
 * Register a situational merchant: a marker rule with `action {situational:true}`
 * and priority 10 (evaluated before category rules). Idempotent — an existing
 * enabled rule with the same match is reused, and a category rule with that
 * match is upgraded to situational.
 */
export async function addSituationalMerchant(
  value: string,
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const v = value.trim();
  if (!v) throw new Error("situational merchant value is required");
  const match = containsMerchantMatch(v);

  const [existing] = await database
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.domain, TRIAGE_DOMAIN),
        eq(rules.enabled, true),
        eq(rules.match, match as never),
      ),
    )
    .limit(1);
  if (existing) {
    if (isSituational(existing.action)) return existing;
    const [upgraded] = await database
      .update(rules)
      .set({ action: { situational: true } as never, updatedAt: new Date() })
      .where(eq(rules.id, existing.id))
      .returning();
    return upgraded;
  }

  const [row] = await database
    .insert(rules)
    .values({
      domain: TRIAGE_DOMAIN,
      name: `situational: ${v.slice(0, 80)}`,
      match: match as never,
      action: { situational: true } as never,
      priority: 10,
      enabled: true,
      createdBy: "situational",
    })
    .returning();
  return row;
}

export type ConsolidationSuggestion = {
  category: string;
  /** Shared lowercased token, e.g. "amazon". */
  token: string;
  /** The exact-match rules a single `contains` rule could replace. */
  rules: Array<{ id: number; value: string }>;
};

/**
 * Find groups of near-duplicate exact-match rules: enabled `equals` rules that
 * share the same category and a common merchant token. Each suggestion can be
 * consolidated into one `containsMerchantMatch` rule.
 */
export function findConsolidations(ruleRows: RuleRow[]): ConsolidationSuggestion[] {
  type ExactRule = { id: number; value: string; category: string };
  const exact: ExactRule[] = [];
  for (const r of ruleRows) {
    if (!r.enabled) continue;
    const m = r.match as { op?: string; value?: unknown } | null;
    if (!m || m.op !== "equals" || typeof m.value !== "string") continue;
    const cat = (r.action as { category?: unknown } | null)?.category;
    if (typeof cat !== "string" || !cat) continue;
    exact.push({ id: r.id, value: m.value, category: cat });
  }

  // category -> token -> rules carrying that token
  const byCat = new Map<string, Map<string, ExactRule[]>>();
  for (const r of exact) {
    const tokens = new Set(
      r.value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4),
    );
    let tokenMap = byCat.get(r.category);
    if (!tokenMap) {
      tokenMap = new Map();
      byCat.set(r.category, tokenMap);
    }
    for (const t of tokens) {
      const arr = tokenMap.get(t) ?? [];
      arr.push(r);
      tokenMap.set(t, arr);
    }
  }

  const suggestions: ConsolidationSuggestion[] = [];
  for (const [category, tokenMap] of byCat) {
    for (const [token, rs] of tokenMap) {
      if (rs.length < 2) continue;
      suggestions.push({
        category,
        token,
        rules: rs.map((r) => ({ id: r.id, value: r.value })),
      });
    }
  }
  // Most-impactful first; cap so the cleanup UI stays scannable.
  suggestions.sort((a, b) => b.rules.length - a.rules.length);
  return suggestions.slice(0, 20);
}

/**
 * Replace a set of exact-match rules with one broader `contains` rule for the
 * same category. Creates (or reuses) the contains rule, then deletes the listed
 * exact rules. Returns the contains rule.
 */
export async function consolidateRules(
  params: { token: string; category: string; ruleIds: number[] },
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const token = params.token.trim();
  if (!token) throw new Error("consolidation token is required");
  if (params.ruleIds.length === 0) throw new Error("no rules to consolidate");
  const match = containsMerchantMatch(token);
  const action = {
    category: params.category,
    reasoning: `consolidated from ${params.ruleIds.length} exact rules`,
  };

  const [existing] = await database
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.domain, TRIAGE_DOMAIN),
        eq(rules.enabled, true),
        eq(rules.match, match as never),
      ),
    )
    .limit(1);

  let rule: RuleRow;
  if (existing) {
    [rule] = await database
      .update(rules)
      .set({ action: action as never, updatedAt: new Date() })
      .where(eq(rules.id, existing.id))
      .returning();
  } else {
    [rule] = await database
      .insert(rules)
      .values({
        domain: TRIAGE_DOMAIN,
        name: `auto: contains "${token}"`,
        match: match as never,
        action: action as never,
        priority: 100,
        enabled: true,
        createdBy: "consolidation",
      })
      .returning();
  }

  // Drop the now-redundant exact rules — never the contains rule itself.
  const toDelete = params.ruleIds.filter((id) => id !== rule.id);
  if (toDelete.length > 0) {
    await database
      .delete(rules)
      .where(and(eq(rules.domain, TRIAGE_DOMAIN), inArray(rules.id, toDelete)));
  }
  return rule;
}
