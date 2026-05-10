import type { OAuth2Client } from "google-auth-library";
import {
  batchUpdateCells,
  colLetter,
  getFirstSheetTitle,
  readContactsTab,
  type CellUpdate,
} from "../integrations/google/sheets.js";
import { addToCsv, removeFromCsv } from "./csv.js";

const RESOURCE_NAME_COL = "google_resource_name";

export type FoundRow = {
  rowIndex: number;
  record: Record<string, string>;
  tab: string;
  headers: string[];
};

export class ContactNotFoundError extends Error {
  constructor(public readonly resourceName: string) {
    super(`contact ${resourceName} not found in sheet`);
    this.name = "ContactNotFoundError";
  }
}

export class UnknownColumnError extends Error {
  constructor(public readonly column: string) {
    super(`column ${column} not present in sheet headers`);
    this.name = "UnknownColumnError";
  }
}

async function findRow(client: OAuth2Client, spreadsheetId: string, resourceName: string): Promise<FoundRow> {
  const tab = await getFirstSheetTitle(client, spreadsheetId);
  const data = await readContactsTab(client, spreadsheetId, { tab });
  const row = data.rows.find((r) => (r.record[RESOURCE_NAME_COL] ?? "") === resourceName);
  if (!row) throw new ContactNotFoundError(resourceName);
  return { rowIndex: row.rowIndex, record: row.record, tab, headers: data.headers };
}

async function writeCell(
  client: OAuth2Client,
  spreadsheetId: string,
  found: FoundRow,
  column: string,
  value: string,
): Promise<void> {
  const colIdx = found.headers.indexOf(column);
  if (colIdx === -1) throw new UnknownColumnError(column);
  const sheetRow = found.rowIndex + 2; // +1 for 1-based, +1 for header
  const update: CellUpdate = { range: `${found.tab}!${colLetter(colIdx)}${sheetRow}`, value };
  await batchUpdateCells(client, spreadsheetId, [update]);
}

export type CsvOpResult = {
  resource_name: string;
  row_index: number;
  field: "groups" | "tags";
  value: string; // post-update CSV
  changed: boolean;
};

export async function addToCsvField(
  client: OAuth2Client,
  spreadsheetId: string,
  resourceName: string,
  field: "groups" | "tags",
  additions: string[],
): Promise<CsvOpResult> {
  const found = await findRow(client, spreadsheetId, resourceName);
  const current = found.record[field] ?? "";
  const result = addToCsv(current, additions);
  if (result.changed) await writeCell(client, spreadsheetId, found, field, result.value);
  return { resource_name: resourceName, row_index: found.rowIndex, field, value: result.value, changed: result.changed };
}

export async function removeFromCsvField(
  client: OAuth2Client,
  spreadsheetId: string,
  resourceName: string,
  field: "groups" | "tags",
  removals: string[],
): Promise<CsvOpResult> {
  const found = await findRow(client, spreadsheetId, resourceName);
  const current = found.record[field] ?? "";
  const result = removeFromCsv(current, removals);
  if (result.changed) await writeCell(client, spreadsheetId, found, field, result.value);
  return { resource_name: resourceName, row_index: found.rowIndex, field, value: result.value, changed: result.changed };
}

export type BoolOpResult = {
  resource_name: string;
  row_index: number;
  field: "is_archived" | "starred";
  value: boolean;
  changed: boolean;
};

function parseBoolish(raw: string): boolean {
  return raw.trim().toLowerCase() === "true";
}

export async function setBoolField(
  client: OAuth2Client,
  spreadsheetId: string,
  resourceName: string,
  field: "is_archived" | "starred",
  value: boolean,
): Promise<BoolOpResult> {
  const found = await findRow(client, spreadsheetId, resourceName);
  const current = parseBoolish(found.record[field] ?? "");
  const next = value;
  if (current !== next) {
    await writeCell(client, spreadsheetId, found, field, next ? "TRUE" : "FALSE");
  }
  return {
    resource_name: resourceName,
    row_index: found.rowIndex,
    field,
    value: next,
    changed: current !== next,
  };
}
