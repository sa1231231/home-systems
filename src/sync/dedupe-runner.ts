import type { OAuth2Client } from "google-auth-library";
import {
  batchUpdateCells,
  colLetter,
  deleteDataRows,
  getFirstSheetTitle,
  getSheetIdByTitle,
  readContactsTab,
  type CellUpdate,
} from "../integrations/google/sheets.js";
import { planDedupe, summarizeDedupe, type DedupePlan, type DedupeSummary } from "./dedupe.js";

export type DedupeResult = {
  plan: DedupePlan;
  summary: DedupeSummary;
  applied: boolean;
  tab: string;
  headers: string[];
};

export async function runDedupe(
  client: OAuth2Client,
  spreadsheetId: string,
  opts: { dryRun: boolean; tab?: string } = { dryRun: true },
): Promise<DedupeResult> {
  const tab = opts.tab ?? (await getFirstSheetTitle(client, spreadsheetId));
  const contactsTab = await readContactsTab(client, spreadsheetId, { tab });
  const plan = planDedupe(contactsTab.rows);
  const summary = summarizeDedupe(plan);
  if (opts.dryRun) {
    return { plan, summary, applied: false, tab, headers: contactsTab.headers };
  }

  const headerIndex = (col: string) => contactsTab.headers.indexOf(col);

  // Step 1: batch-update canonical rows with merged values.
  const cellUpdates: CellUpdate[] = [];
  for (const merge of plan.merges) {
    const sheetRow = merge.canonicalRowIndex + 2; // +1 1-based, +1 header
    for (const [col, value] of Object.entries(merge.fills)) {
      const colIdx = headerIndex(col);
      if (colIdx === -1) continue;
      cellUpdates.push({ range: `${tab}!${colLetter(colIdx)}${sheetRow}`, value });
    }
  }
  await batchUpdateCells(client, spreadsheetId, cellUpdates);

  // Step 2: delete non-canonical rows (bottom-up so indices stay valid).
  const sheetId = await getSheetIdByTitle(client, spreadsheetId, tab);
  await deleteDataRows(client, spreadsheetId, sheetId, plan.rowsToDelete);

  return { plan, summary, applied: true, tab, headers: contactsTab.headers };
}
