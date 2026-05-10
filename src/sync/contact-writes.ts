import type { OAuth2Client } from "google-auth-library";
import { withChangelog } from "../changelog/index.js";
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

export type WriteMeta = {
  sessionId: string;
  caller: string;
  intent?: string;
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

function cellRangeFor(found: FoundRow, column: string): string {
  const colIdx = found.headers.indexOf(column);
  if (colIdx === -1) throw new UnknownColumnError(column);
  const sheetRow = found.rowIndex + 2; // +1 for 1-based, +1 for header
  return `${found.tab}!${colLetter(colIdx)}${sheetRow}`;
}

export type CsvOpResult = {
  resource_name: string;
  row_index: number;
  field: "groups" | "tags";
  value: string; // post-update CSV
  changed: boolean;
};

async function applyCsvChange(
  client: OAuth2Client,
  spreadsheetId: string,
  resourceName: string,
  field: "groups" | "tags",
  operation: "add_csv" | "remove_csv",
  before: string,
  after: string,
  found: FoundRow,
  meta: WriteMeta,
): Promise<void> {
  const range = cellRangeFor(found, field);
  const update: CellUpdate = { range, value: after };
  await withChangelog(
    {
      caller: meta.caller,
      sessionId: meta.sessionId,
      operation: `contacts.${operation}.${field}`,
      targetKind: "contact",
      targetId: resourceName,
      intent: meta.intent,
      before: { [field]: before },
      after: { [field]: after },
      externalTarget: `google.sheet:${spreadsheetId}!${range}`,
    },
    async () => {
      await batchUpdateCells(client, spreadsheetId, [update]);
    },
  );
}

export async function addToCsvField(
  client: OAuth2Client,
  spreadsheetId: string,
  resourceName: string,
  field: "groups" | "tags",
  additions: string[],
  meta: WriteMeta,
): Promise<CsvOpResult> {
  const found = await findRow(client, spreadsheetId, resourceName);
  const current = found.record[field] ?? "";
  const result = addToCsv(current, additions);
  if (result.changed) {
    await applyCsvChange(client, spreadsheetId, resourceName, field, "add_csv", current, result.value, found, meta);
  }
  return { resource_name: resourceName, row_index: found.rowIndex, field, value: result.value, changed: result.changed };
}

export async function removeFromCsvField(
  client: OAuth2Client,
  spreadsheetId: string,
  resourceName: string,
  field: "groups" | "tags",
  removals: string[],
  meta: WriteMeta,
): Promise<CsvOpResult> {
  const found = await findRow(client, spreadsheetId, resourceName);
  const current = found.record[field] ?? "";
  const result = removeFromCsv(current, removals);
  if (result.changed) {
    await applyCsvChange(
      client,
      spreadsheetId,
      resourceName,
      field,
      "remove_csv",
      current,
      result.value,
      found,
      meta,
    );
  }
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
  meta: WriteMeta,
): Promise<BoolOpResult> {
  const found = await findRow(client, spreadsheetId, resourceName);
  const current = parseBoolish(found.record[field] ?? "");
  const next = value;
  if (current !== next) {
    const range = cellRangeFor(found, field);
    await withChangelog(
      {
        caller: meta.caller,
        sessionId: meta.sessionId,
        operation: `contacts.set_bool.${field}`,
        targetKind: "contact",
        targetId: resourceName,
        intent: meta.intent,
        before: { [field]: current },
        after: { [field]: next },
        externalTarget: `google.sheet:${spreadsheetId}!${range}`,
      },
      async () => {
        await batchUpdateCells(client, spreadsheetId, [{ range, value: next ? "TRUE" : "FALSE" }]);
      },
    );
  }
  return {
    resource_name: resourceName,
    row_index: found.rowIndex,
    field,
    value: next,
    changed: current !== next,
  };
}
