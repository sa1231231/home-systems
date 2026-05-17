/**
 * One-off: consolidate duplicate contact rows in the CRM sheet.
 *
 * A duplicate group is ≥2 rows sharing a normalized full_name where exactly
 * one row has a google_resource_name (the synced row = keeper) — the rest are
 * pre-existing name-only rows the matcher failed to bind. Each group is merged
 * into the keeper (union of all data, zero loss) and the duplicates deleted.
 *
 *   npx tsx scripts/contacts-consolidate-duplicates.ts            # dry run
 *   npx tsx scripts/contacts-consolidate-duplicates.ts --apply    # mutate
 */
import "dotenv/config";
import { getConfig } from "../src/config.js";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import {
  batchUpdateCells,
  colLetter,
  deleteDataRows,
  getSheetIdByTitle,
  readContactsTab,
  type CellUpdate,
} from "../src/integrations/google/sheets.js";
import { findDuplicateNameGroups } from "../src/sync/contacts-audit.js";
import { buildMergePlan } from "../src/sync/contacts-merge.js";
import { withChangelog, newSessionId } from "../src/changelog/index.js";
import { pool } from "../src/db/client.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const creds = requireGoogleCreds();
  const client = getOAuthClient();
  const tab = getConfig().CONTACTS_TAB;

  const ct = await readContactsTab(client, creds.sheetId, { tab });
  const groups = findDuplicateNameGroups(ct.rows);
  console.log(`Duplicate-name groups (one keeper + name-only dupes): ${groups.length}`);
  console.log(apply ? "MODE: apply\n" : "MODE: dry run (pass --apply to mutate)\n");

  const cellUpdates: CellUpdate[] = [];
  const deleteRowIndices: number[] = [];
  const changelogGroups: unknown[] = [];

  for (const g of groups) {
    const rowsForMerge = ct.rows.filter(
      (r) => r.rowIndex === g.keeperRowIndex || g.duplicateRowIndices.includes(r.rowIndex),
    );
    const plan = buildMergePlan(rowsForMerge, ct.headers, { keeperRowIndex: g.keeperRowIndex });
    const keeperSheetRow = plan.keeperRowIndex + 2; // +1 1-based, +1 header
    console.log(
      `  "${g.name}" — keep row ${g.keeperRowIndex}, fold + delete ${plan.deleteRowIndices.join(", ")}` +
        ` (${plan.updates.length} cell update${plan.updates.length === 1 ? "" : "s"})`,
    );
    for (const u of plan.updates) {
      const colIdx = ct.headers.indexOf(u.col);
      if (colIdx === -1) continue;
      cellUpdates.push({
        range: `${ct.tab}!${colLetter(colIdx)}${keeperSheetRow}`,
        value: u.to,
      });
    }
    deleteRowIndices.push(...plan.deleteRowIndices);
    changelogGroups.push({
      name: g.name,
      keeper_row_index: plan.keeperRowIndex,
      delete_row_indices: plan.deleteRowIndices,
      updates: plan.updates,
      before_rows: plan.beforeRows,
    });
  }

  console.log(
    `\n${apply ? "Applying" : "Would apply"}: ${cellUpdates.length} cell update(s), ` +
      `${deleteRowIndices.length} row deletion(s).`,
  );

  if (apply && groups.length > 0) {
    const sheetId = await getSheetIdByTitle(client, creds.sheetId, ct.tab);
    await withChangelog(
      {
        caller: "cleanup:contacts.consolidate-duplicates",
        sessionId: newSessionId(),
        operation: "contacts.consolidate_duplicates",
        targetKind: "contact_row",
        targetId: `${ct.tab}!consolidate-duplicates`,
        intent: `consolidate ${groups.length} duplicate-name group(s)`,
        before: { groups: changelogGroups },
        after: { groups: groups.length, updates: cellUpdates.length, deletes: deleteRowIndices.length },
        externalTarget: `google.sheet:${creds.sheetId}!${ct.tab}`,
      },
      async () => {
        // Updates first (pre-delete row indices), then deletes bottom-up so
        // surviving indices stay valid.
        if (cellUpdates.length > 0) await batchUpdateCells(client, creds.sheetId, cellUpdates);
        if (deleteRowIndices.length > 0) {
          await deleteDataRows(client, creds.sheetId, sheetId, deleteRowIndices);
        }
      },
    );
    console.log("✓ Done.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
