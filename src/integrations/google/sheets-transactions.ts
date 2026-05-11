import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { batchUpdateCells, colLetter } from "./sheets.js";

export type TransactionRow = {
  rowIndex: number; // 0-based index after the header row
  transactionId: string;
  date: string;
  description: string;
  fullDescription: string;
  amount: string;
  account: string;
  institution: string;
  categoryHint: string;
  source: string;
  category: string;
  categorizedBy: string;
  categorizedDate: string;
};

export type TransactionsTab = {
  tab: string;
  headers: string[];
  columnIndex: {
    transactionId: number;
    category: number;
    categorizedBy: number;
    categorizedDate: number;
  };
  rows: TransactionRow[];
};

const REQUIRED_COLUMNS = [
  "Transaction ID",
  "Category",
  "Categorized By",
  "Categorized Date",
] as const;

function findColumn(headers: string[], name: string): number {
  const idx = headers.findIndex((h) => h.trim() === name);
  if (idx < 0) {
    throw new Error(
      `transactions sheet is missing required column "${name}". Found: ${headers.join(", ")}`,
    );
  }
  return idx;
}

function cell(row: (string | number | boolean | null | undefined)[], i: number): string {
  const v = row[i];
  return v == null ? "" : String(v);
}

export type RawSheetValues = (string | number | boolean | null)[][];

/**
 * Pure parser for transactions sheet values. Validates required columns,
 * discovers optional columns, and produces typed rows keyed on Transaction ID.
 * Exported for unit tests; production callers should use readTransactionsSheet.
 */
export function parseTransactionsValues(values: RawSheetValues, tab: string): TransactionsTab {
  if (values.length === 0) {
    return {
      tab,
      headers: [],
      columnIndex: { transactionId: -1, category: -1, categorizedBy: -1, categorizedDate: -1 },
      rows: [],
    };
  }
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  for (const required of REQUIRED_COLUMNS) findColumn(headers, required);

  const columnIndex = {
    transactionId: findColumn(headers, "Transaction ID"),
    category: findColumn(headers, "Category"),
    categorizedBy: findColumn(headers, "Categorized By"),
    categorizedDate: findColumn(headers, "Categorized Date"),
  };

  // Optional informational columns. Missing ones return empty string.
  const optional = {
    date: headers.findIndex((h) => h === "Date"),
    description: headers.findIndex((h) => h === "Description"),
    fullDescription: headers.findIndex((h) => h === "Full Description"),
    amount: headers.findIndex((h) => h === "Amount"),
    account: headers.findIndex((h) => h === "Account"),
    institution: headers.findIndex((h) => h === "Institution"),
    categoryHint: headers.findIndex((h) => h === "Category Hint"),
    source: headers.findIndex((h) => h === "Source"),
  };

  const rows: TransactionRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    const transactionId = cell(raw, columnIndex.transactionId).trim();
    if (!transactionId) continue; // skip rows without a stable ID
    rows.push({
      rowIndex: i - 1,
      transactionId,
      date: optional.date >= 0 ? cell(raw, optional.date) : "",
      description: optional.description >= 0 ? cell(raw, optional.description) : "",
      fullDescription: optional.fullDescription >= 0 ? cell(raw, optional.fullDescription) : "",
      amount: optional.amount >= 0 ? cell(raw, optional.amount) : "",
      account: optional.account >= 0 ? cell(raw, optional.account) : "",
      institution: optional.institution >= 0 ? cell(raw, optional.institution) : "",
      categoryHint: optional.categoryHint >= 0 ? cell(raw, optional.categoryHint) : "",
      source: optional.source >= 0 ? cell(raw, optional.source) : "",
      category: cell(raw, columnIndex.category),
      categorizedBy: cell(raw, columnIndex.categorizedBy),
      categorizedDate: cell(raw, columnIndex.categorizedDate),
    });
  }
  return { tab, headers, columnIndex, rows };
}

/**
 * Pure parser for the Categories enum sheet. Dedupes, trims, preserves order.
 * Throws on missing column or empty enum. Exported for tests.
 */
export function parseCategoriesValues(values: RawSheetValues, tab: string): string[] {
  if (values.length === 0) {
    throw new Error(`categories sheet "${tab}" is empty`);
  }
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const catCol = headers.findIndex((h) => h === "Category");
  if (catCol < 0) {
    throw new Error(
      `categories sheet "${tab}" has no "Category" column. Found: ${headers.join(", ")}`,
    );
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let i = 1; i < values.length; i++) {
    const v = String(values[i]?.[catCol] ?? "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    ordered.push(v);
  }
  if (ordered.length === 0) {
    throw new Error(`categories sheet "${tab}" has no non-empty Category values`);
  }
  return ordered;
}

export async function readTransactionsSheet(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
): Promise<TransactionsTab> {
  const sheets = google.sheets({ version: "v4", auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:ZZ`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return parseTransactionsValues((res.data.values ?? []) as RawSheetValues, tab);
}

export async function readCategoriesEnum(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
): Promise<string[]> {
  const sheets = google.sheets({ version: "v4", auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:Z`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return parseCategoriesValues((res.data.values ?? []) as RawSheetValues, tab);
}

export type TransactionWriteFields = {
  category: string;
  categorizedBy: string;
  categorizedDate: string;
};

export type TransactionWriteSnapshot = {
  before: TransactionWriteFields;
  after: TransactionWriteFields;
  rowIndex: number;
};

export async function writeTransactionCategory(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: TransactionsTab,
  row: TransactionRow,
  fields: TransactionWriteFields,
): Promise<TransactionWriteSnapshot> {
  // Sheet row is row.rowIndex + 2 (1-based, header on row 1).
  const sheetRow = row.rowIndex + 2;
  const ranges: { range: string; value: string }[] = [
    {
      range: `${tab.tab}!${colLetter(tab.columnIndex.category)}${sheetRow}`,
      value: fields.category,
    },
    {
      range: `${tab.tab}!${colLetter(tab.columnIndex.categorizedBy)}${sheetRow}`,
      value: fields.categorizedBy,
    },
    {
      range: `${tab.tab}!${colLetter(tab.columnIndex.categorizedDate)}${sheetRow}`,
      value: fields.categorizedDate,
    },
  ];
  await batchUpdateCells(client, spreadsheetId, ranges);
  return {
    rowIndex: row.rowIndex,
    before: {
      category: row.category,
      categorizedBy: row.categorizedBy,
      categorizedDate: row.categorizedDate,
    },
    after: fields,
  };
}
