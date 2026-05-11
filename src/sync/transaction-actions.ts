import type { OAuth2Client } from "google-auth-library";
import { withChangelog } from "../changelog/index.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import {
  readCategoriesEnum,
  readTransactionsSheet,
  writeTransactionCategory,
  type TransactionRow,
} from "../integrations/google/sheets-transactions.js";

export const TRANSACTION_CATEGORIZE_OP = "transaction.categorize";

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
  const tab = await readTransactionsSheet(client, target.sheetId, target.transactionsTab);
  const row = tab.rows.find((r) => r.transactionId === input.transactionId);
  if (!row) {
    throw new Error(
      `transaction "${input.transactionId}" not found in tab "${target.transactionsTab}"`,
    );
  }

  const enumValues = await readCategoriesEnum(client, target.sheetId, target.categoriesTab);
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
    },
  );

  return {
    transactionId: snapshotRow.transactionId,
    rowIndex: snapshotRow.rowIndex,
    category: after.category,
    changed: true,
  };
}
