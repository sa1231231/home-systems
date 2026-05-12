import type { OAuth2Client } from "google-auth-library";
import { withChangelog, newSessionId } from "../changelog/index.js";
import { batchUpdateCells, colLetter, type CellUpdate } from "../integrations/google/sheets.js";
import type { RefreshOp, SyncPlan } from "./contacts.js";

const RESOURCE_NAME_COL = "google_resource_name";
export const BACKFILL_OP = "contacts.backfill_resource_name";

/**
 * Apply "trivial" refresh ops that only fill in google_resource_name on
 * already-matched rows. Treated as a Tier-A benign write — bypasses the
 * needs_review queue because the only change is binding Google's stable
 * ID to a row we already know matches by email/phone/name. Logged to the
 * changelog as one entry per run so it shows on /ui/changes and can be
 * undone if it ever turns out to be wrong (the reverser would clear the
 * resource_name back to empty, which is the prior state).
 */
export async function applyResourceNameBackfills(
  client: OAuth2Client,
  plan: SyncPlan,
  refreshes: RefreshOp[],
): Promise<void> {
  if (refreshes.length === 0) return;
  const colIdx = plan.headers.indexOf(RESOURCE_NAME_COL);
  if (colIdx === -1) return;

  const cellUpdates: CellUpdate[] = [];
  const bindings: Array<{ row_index: number; resource_name: string }> = [];
  for (const op of refreshes) {
    const sheetRow = op.rowIndex + 2; // +1 1-based, +1 header
    cellUpdates.push({
      range: `${plan.tab}!${colLetter(colIdx)}${sheetRow}`,
      value: op.person.resource_name,
    });
    bindings.push({ row_index: op.rowIndex, resource_name: op.person.resource_name });
  }

  await withChangelog(
    {
      caller: "sync:contacts.backfill-resource-names",
      sessionId: newSessionId(),
      operation: BACKFILL_OP,
      targetKind: "contact_rows",
      targetId: `${plan.tab}!bulk[${refreshes.length}]`,
      intent: `bind google_resource_name to ${refreshes.length} sheet row(s) matched by email/phone/name`,
      before: {
        tab: plan.tab,
        rows: bindings.map((b) => ({ row_index: b.row_index, resource_name: "" })),
      },
      after: { tab: plan.tab, rows: bindings },
      externalTarget: `google.sheet:${plan.spreadsheetId}!${plan.tab}`,
    },
    async () => {
      await batchUpdateCells(client, plan.spreadsheetId, cellUpdates);
    },
  );
}
