import type { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { rules } from "../db/schema.js";
import {
  readCategoriesEnum,
  readTransactionsSheet,
  type TransactionRow,
} from "../integrations/google/sheets-transactions.js";
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
