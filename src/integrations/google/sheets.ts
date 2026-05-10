import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type SheetPreview = {
  tab: string;
  headers: string[];
  rows: Record<string, string>[];
};

export function rowsToRecords(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
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
  // +1 for header row. ZZ covers any reasonable column count.
  const range = `${tab}!A1:ZZ${limit + 1}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values ?? [];
  if (values.length === 0) {
    return { tab, headers: [], rows: [] };
  }
  const [headers, ...rest] = values as string[][];
  return { tab, headers, rows: rowsToRecords(headers, rest) };
}
