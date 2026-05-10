/**
 * One-time Sheet column cleanup. Drops legacy Dex auto-tracking columns,
 * renames identity prefixes (dex_email → email, etc.), and reorders to the
 * canonical layout in src/sync/cleanup.ts.
 *
 * Usage (dry-run):
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *   GOOGLE_OAUTH_REFRESH_TOKEN=... CRM_SHEET_ID=... \
 *   npm run cleanup:columns
 *
 * Usage (apply):
 *   ... npm run cleanup:columns -- --apply
 *
 * Sheet revision history is your rollback. After apply, run a sync dry-run
 * (curl /contacts/sync/plan) to confirm everything still matches cleanly.
 */
import { google } from "googleapis";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import { getFirstSheetTitle, readContactsTab } from "../src/integrations/google/sheets.js";
import { NEW_COLUMNS, planCleanup, transformRows } from "../src/sync/cleanup.js";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");

async function main(): Promise<void> {
  let creds;
  try {
    creds = requireGoogleCreds();
  } catch {
    console.error(
      "missing Google credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, CRM_SHEET_ID.",
    );
    process.exit(1);
  }

  const client = getOAuthClient();
  const tab = await getFirstSheetTitle(client, creds.sheetId);
  const contactsTab = await readContactsTab(client, creds.sheetId, { tab });

  const plan = planCleanup(contactsTab.headers);

  console.log(`tab: ${tab}`);
  console.log(`existing columns: ${plan.oldHeaders.length}`);
  console.log(`new columns:      ${plan.newHeaders.length}`);
  console.log(`existing rows:    ${contactsTab.rows.length}`);
  console.log("");

  if (plan.alreadyClean) {
    console.log("✓ sheet is already in the new shape — nothing to do");
    return;
  }

  console.log(`drops (${plan.dropped.length}):`);
  for (const c of plan.dropped) console.log(`  - ${c}`);
  console.log("");
  console.log(`renames (${plan.renamed.length}):`);
  for (const r of plan.renamed) console.log(`  - ${r.from}  →  ${r.to}`);
  console.log("");
  console.log(`kept (${plan.kept.length}):`);
  for (const c of plan.kept) console.log(`  - ${c}`);
  console.log("");

  const oldRowsRaw = contactsTab.rows.map((r) => plan.oldHeaders.map((h) => r.record[h] ?? ""));
  const newRows = transformRows(plan.oldHeaders, oldRowsRaw);
  console.log(`transformed rows: ${newRows.length} (× ${plan.newHeaders.length} columns)`);

  if (!APPLY) {
    console.log("\ndry-run (no changes). Re-run with --apply to write.");
    return;
  }

  console.log("\napplying — clearing existing tab and writing new layout…");

  const sheets = google.sheets({ version: "v4", auth: client });

  const clearRange = `${tab}!A1:ZZ`;
  await sheets.spreadsheets.values.clear({ spreadsheetId: creds.sheetId, range: clearRange });
  console.log(`  cleared ${clearRange}`);

  const writeRange = `${tab}!A1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: creds.sheetId,
    range: writeRange,
    valueInputOption: "RAW",
    requestBody: { values: [plan.newHeaders, ...newRows] },
  });
  console.log(`  wrote ${1 + newRows.length} rows × ${plan.newHeaders.length} columns to ${writeRange}`);
  console.log("\n✓ done. Verify with: curl /contacts/sync/plan and inspect Sheet revision history.");
}

main().catch((err) => {
  console.error("cleanup failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
