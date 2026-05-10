import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type SheetPreview = {
  tab: string;
  headers: string[];
  rows: Record<string, string>[];
};

export type ContactsTab = {
  tab: string;
  headers: string[];
  rows: { rowIndex: number; record: Record<string, string> }[];
};

export function rowsToRecords(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
}

export function colLetter(zeroBasedIndex: number): string {
  let n = zeroBasedIndex;
  let s = "";
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

export async function getFirstSheetTitle(client: OAuth2Client, spreadsheetId: string): Promise<string> {
  const sheets = google.sheets({ version: "v4", auth: client });
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  const title = res.data.sheets?.[0]?.properties?.title;
  if (!title) {
    throw new Error(`spreadsheet ${spreadsheetId} has no sheets`);
  }
  return title;
}

export async function previewSheet(
  client: OAuth2Client,
  spreadsheetId: string,
  opts: { tab?: string; limit?: number } = {},
): Promise<SheetPreview> {
  const tab = opts.tab ?? (await getFirstSheetTitle(client, spreadsheetId));
  const limit = opts.limit ?? 20;
  const sheets = google.sheets({ version: "v4", auth: client });
  const range = `${tab}!A1:ZZ${limit + 1}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values ?? [];
  if (values.length === 0) {
    return { tab, headers: [], rows: [] };
  }
  const [headers, ...rest] = values as string[][];
  return { tab, headers, rows: rowsToRecords(headers, rest) };
}

export async function readContactsTab(
  client: OAuth2Client,
  spreadsheetId: string,
  opts: { tab?: string } = {},
): Promise<ContactsTab> {
  const tab = opts.tab ?? (await getFirstSheetTitle(client, spreadsheetId));
  const sheets = google.sheets({ version: "v4", auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:ZZ`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as (string | number | boolean | null)[][];
  if (values.length === 0) {
    return { tab, headers: [], rows: [] };
  }
  const headers = (values[0] ?? []).map((h) => String(h ?? ""));
  const rows = values.slice(1).map((raw, i) => ({
    rowIndex: i,
    record: Object.fromEntries(headers.map((h, j) => [h, String(raw[j] ?? "")])),
  }));
  return { tab, headers, rows };
}

export async function setHeaderCell(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
  columnIndex: number,
  value: string,
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth: client });
  const a1 = `${tab}!${colLetter(columnIndex)}1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

export async function appendRows(
  client: OAuth2Client,
  spreadsheetId: string,
  tab: string,
  rows: string[][],
): Promise<void> {
  if (rows.length === 0) return;
  const sheets = google.sheets({ version: "v4", auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

export type CellUpdate = { range: string; value: string };

export async function batchUpdateCells(
  client: OAuth2Client,
  spreadsheetId: string,
  updates: CellUpdate[],
): Promise<void> {
  if (updates.length === 0) return;
  const sheets = google.sheets({ version: "v4", auth: client });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
    },
  });
}
