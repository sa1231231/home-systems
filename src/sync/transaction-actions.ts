import type { OAuth2Client } from "google-auth-library";
import { withChangelog } from "../changelog/index.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import {
  readCategoriesEnum,
  readTransactionsSheet,
  writeTransactionCategory,
  type TransactionRow,
  type TransactionsTab,
} from "../integrations/google/sheets-transactions.js";

export const TRANSACTION_CATEGORIZE_OP = "transaction.categorize";

// In-process TTL cache for the two sheet reads done on every apply. Google's
// per-user-per-minute Sheets read quota is ~60; a rapid burst of approvals
// from the UI used to blow through that with 2 reads per click. 30s on the
// Transactions tab (rare row deletes), 60s on the Categories tab (changes
// almost never). Cache is shared across all callers in this process —
// invalidate explicitly if you mutate the sheet structure (insert/delete
// rows) outside of applyTransactionCategory's own write path.
type CacheEntry<T> = { value: T; expiresAt: number };
const TX_TTL_MS = 30_000;
const ENUM_TTL_MS = 60_000;
const txCache = new Map<string, CacheEntry<TransactionsTab>>();
const enumCache = new Map<string, CacheEntry<string[]>>();

async function cachedReadTransactionsSheet(
  client: OAuth2Client,
  sheetId: string,
  tab: string,
): Promise<TransactionsTab> {
  const key = `${sheetId}|${tab}`;
  const hit = txCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await readTransactionsSheet(client, sheetId, tab);
  txCache.set(key, { value, expiresAt: Date.now() + TX_TTL_MS });
  return value;
}

async function cachedReadCategoriesEnum(
  client: OAuth2Client,
  sheetId: string,
  tab: string,
): Promise<string[]> {
  const key = `${sheetId}|${tab}`;
  const hit = enumCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await readCategoriesEnum(client, sheetId, tab);
  enumCache.set(key, { value, expiresAt: Date.now() + ENUM_TTL_MS });
  return value;
}

/** Wipe caches — for tests and for callers who know the sheet just changed shape. */
export function clearTransactionSheetCaches(): void {
  txCache.clear();
  enumCache.clear();
}

export type TransactionActionMeta = {
  sessionId: string;
  caller: string;
  intent?: string;
};

export type TransactionTarget = {
  sheetId: string;
  transactionsTab: string;
  categoriesTab: string;
};

export type ApplyTransactionInput = {
  transactionId: string;
  category: string;
  categorizedBy: string; // e.g. "rule:42" | "ai:approved" | "ai:corrected"
};

export type ApplyTransactionResult = {
  transactionId: string;
  rowIndex: number;
  category: string;
  changed: boolean;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function applyTransactionCategory(
  client: OAuth2Client,
  target: TransactionTarget,
  input: ApplyTransactionInput,
  meta: TransactionActionMeta,
): Promise<ApplyTransactionResult> {
  const tab = await cachedReadTransactionsSheet(
    client,
    target.sheetId,
    target.transactionsTab,
  );
  const row = tab.rows.find((r) => r.transactionId === input.transactionId);
  if (!row) {
    throw new Error(
      `transaction "${input.transactionId}" not found in tab "${target.transactionsTab}"`,
    );
  }

  const enumValues = await cachedReadCategoriesEnum(
    client,
    target.sheetId,
    target.categoriesTab,
  );
  if (!enumValues.includes(input.category)) {
    throw new Error(
      `category "${input.category}" is not in the current Categories enum (${enumValues.length} values)`,
    );
  }

  if (
    row.category === input.category &&
    row.categorizedBy === input.categorizedBy
  ) {
    return {
      transactionId: row.transactionId,
      rowIndex: row.rowIndex,
      category: row.category,
      changed: false,
    };
  }

  await enforceConfiguredDailyLimit(TRANSACTION_CATEGORIZE_OP);

  const fields = {
    category: input.category,
    categorizedBy: input.categorizedBy,
    categorizedDate: todayIso(),
  };

  let snapshotRow: TransactionRow = row;
  let after = fields;
  await withChangelog(
    {
      caller: meta.caller,
      sessionId: meta.sessionId,
      operation: TRANSACTION_CATEGORIZE_OP,
      targetKind: "transaction",
      targetId: row.transactionId,
      intent: meta.intent,
      before: {
        category: row.category,
        categorized_by: row.categorizedBy,
        categorized_date: row.categorizedDate,
      },
      after: {
        category: fields.category,
        categorized_by: fields.categorizedBy,
        categorized_date: fields.categorizedDate,
      },
      externalTarget: `sheet:${target.sheetId}:${target.transactionsTab}:${row.transactionId}`,
    },
    async () => {
      const snap = await writeTransactionCategory(client, target.sheetId, tab, row, fields);
      snapshotRow = { ...row, ...snap.after };
      after = snap.after;
      // Patch the cached row in-place so subsequent applies in the same TTL
      // window don't think the row still has the pre-write Category.
      const cached = txCache.get(`${target.sheetId}|${target.transactionsTab}`);
      const cachedRow = cached?.value.rows.find((r) => r.transactionId === row.transactionId);
      if (cachedRow) {
        cachedRow.category = snap.after.category;
        cachedRow.categorizedBy = snap.after.categorizedBy;
        cachedRow.categorizedDate = snap.after.categorizedDate;
      }
    },
  );

  return {
    transactionId: snapshotRow.transactionId,
    rowIndex: snapshotRow.rowIndex,
    category: after.category,
    changed: true,
  };
}
