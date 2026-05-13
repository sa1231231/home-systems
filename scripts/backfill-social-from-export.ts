/**
 * One-shot: backfill the linkedin + instagram URLs lost when those columns
 * were dropped from dex_contacts. Source is the re-exported "dex_contacts (1)"
 * tab (original Dex export with all original columns). Scope is limited to
 * rows whose dex_groups contains "LinkedIn Connections" or "Instagram
 * Contacts" — the user-confirmed groups for these social channels.
 *
 *   $ npx tsx scripts/backfill-social-from-export.ts          # dry-run
 *   $ npx tsx scripts/backfill-social-from-export.ts --apply  # execute
 *
 * Match strategy: full_name lowercased + trimmed, exact match. Multiple
 * rows in dex_contacts with the same full_name → flagged ambiguous, skipped.
 * No match → flagged unmatched, skipped.
 */
import { google } from "googleapis";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import {
  batchUpdateCells,
  colLetter,
  readContactsTab,
  setHeaderCell,
  type CellUpdate,
} from "../src/integrations/google/sheets.js";
import { newSessionId, withChangelog } from "../src/changelog/index.js";

const SOURCE_TAB = "dex_contacts (1)";
const TARGET_TAB = "dex_contacts";
const LINKEDIN_GROUP = "LinkedIn Connections";
const INSTAGRAM_GROUP = "Instagram Contacts";
const OP = "contacts.backfill_social_from_export";

function nameKey(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function groupsInRow(record: Record<string, string>): string[] {
  const raw = record.dex_groups || record.groups || "";
  return raw.split(",").map((g) => g.trim()).filter((g) => g.length > 0);
}

async function ensureColumn(
  client: ReturnType<typeof getOAuthClient>,
  spreadsheetId: string,
  tab: string,
  headers: string[],
  colName: string,
  apply: boolean,
): Promise<{ headers: string[]; index: number; created: boolean }> {
  const existing = headers.indexOf(colName);
  if (existing !== -1) return { headers, index: existing, created: false };
  const newIndex = headers.length;
  if (apply) {
    await setHeaderCell(client, spreadsheetId, tab, newIndex, colName);
  }
  return { headers: [...headers, colName], index: newIndex, created: true };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const creds = requireGoogleCreds();
  const client = getOAuthClient();

  const source = await readContactsTab(client, creds.sheetId, { tab: SOURCE_TAB });
  const target = await readContactsTab(client, creds.sheetId, { tab: TARGET_TAB });
  console.log(`Source (${SOURCE_TAB}): ${source.rows.length} rows, ${source.headers.length} cols`);
  console.log(`Target (${TARGET_TAB}): ${target.rows.length} rows, ${target.headers.length} cols`);
  console.log(`Mode: ${apply ? "APPLY" : "dry-run (use --apply to execute)"}`);
  console.log();

  // Build name → [rowIndex] map for target
  const targetByName = new Map<string, number[]>();
  for (const r of target.rows) {
    const k = nameKey(r.record.full_name);
    if (!k) continue;
    const arr = targetByName.get(k) ?? [];
    arr.push(r.rowIndex);
    targetByName.set(k, arr);
  }

  type Plan = {
    rowIndex: number;
    fullName: string;
    linkedin?: string;
    instagram?: string;
  };
  const plans = new Map<number, Plan>();
  const stats = {
    sourceLinkedin: 0,
    sourceInstagram: 0,
    matched: 0,
    ambiguous: [] as Array<{ name: string; targetRows: number[] }>,
    unmatched: [] as Array<{ name: string; group: string }>,
    sourceMissingUrl: 0,
  };

  for (const r of source.rows) {
    const groups = groupsInRow(r.record);
    const isLi = groups.includes(LINKEDIN_GROUP);
    const isIg = groups.includes(INSTAGRAM_GROUP);
    if (!isLi && !isIg) continue;
    const fullName = (r.record.full_name ?? "").trim();
    if (!fullName) continue;
    const li = (r.record.linkedin ?? r.record.linkedin_url ?? "").trim();
    const ig = (r.record.instagram ?? "").trim();
    if (isLi) {
      if (!li) {
        stats.sourceMissingUrl++;
      } else {
        stats.sourceLinkedin++;
      }
    }
    if (isIg) {
      if (!ig) {
        stats.sourceMissingUrl++;
      } else {
        stats.sourceInstagram++;
      }
    }

    const matchKey = nameKey(fullName);
    const targetRows = targetByName.get(matchKey) ?? [];
    if (targetRows.length === 0) {
      stats.unmatched.push({ name: fullName, group: isLi ? LINKEDIN_GROUP : INSTAGRAM_GROUP });
      continue;
    }
    if (targetRows.length > 1) {
      stats.ambiguous.push({ name: fullName, targetRows });
      continue;
    }
    const tIdx = targetRows[0];
    const plan: Plan = plans.get(tIdx) ?? { rowIndex: tIdx, fullName };
    if (isLi && li) plan.linkedin = li;
    if (isIg && ig) plan.instagram = ig;
    plans.set(tIdx, plan);
    stats.matched++;
  }

  console.log("Source-side counts:");
  console.log(`  LinkedIn Connections rows w/ linkedin URL: ${stats.sourceLinkedin}`);
  console.log(`  Instagram Contacts rows w/ instagram URL: ${stats.sourceInstagram}`);
  console.log(`  Source rows in those groups missing URL:   ${stats.sourceMissingUrl}`);
  console.log();
  console.log("Matching:");
  console.log(`  matched (1 target row by full_name):       ${stats.matched}`);
  console.log(`  ambiguous (>1 target rows w/ same name):   ${stats.ambiguous.length}`);
  console.log(`  unmatched (no target row for that name):   ${stats.unmatched.length}`);
  console.log();
  console.log(`Target rows that would be updated: ${plans.size}`);
  let linkedinFill = 0,
    instagramFill = 0;
  for (const p of plans.values()) {
    if (p.linkedin) linkedinFill++;
    if (p.instagram) instagramFill++;
  }
  console.log(`  linkedin cells to write:  ${linkedinFill}`);
  console.log(`  instagram cells to write: ${instagramFill}`);

  if (stats.ambiguous.length > 0) {
    console.log("\nAmbiguous sample (first 5):");
    for (const a of stats.ambiguous.slice(0, 5)) {
      console.log(`  - ${a.name} → rows ${a.targetRows.join(", ")}`);
    }
  }
  if (stats.unmatched.length > 0) {
    console.log("\nUnmatched sample (first 5):");
    for (const u of stats.unmatched.slice(0, 5)) {
      console.log(`  - ${u.name} (was in ${u.group})`);
    }
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to execute.");
    return;
  }

  // Expand the sheet grid if needed so we have room for the new headers.
  // Google Sheets only auto-grows on append; explicit column writes beyond
  // the current grid bounds error with "exceeds grid limits."
  const sheetsApi = google.sheets({ version: "v4", auth: client });
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId: creds.sheetId,
    fields: "sheets.properties",
  });
  const sheetProps = (meta.data.sheets ?? [])
    .map((s) => s.properties)
    .find((p) => p?.title === TARGET_TAB);
  if (!sheetProps || sheetProps.sheetId == null) {
    throw new Error(`tab "${TARGET_TAB}" not found in spreadsheet`);
  }
  const currentCols = sheetProps.gridProperties?.columnCount ?? 0;
  // We need room for the two new headers — plan for at least 20 columns to
  // give breathing room without needing another resize soon.
  const desiredCols = Math.max(currentCols, target.headers.length + 4);
  if (desiredCols > currentCols) {
    console.log(`Expanding grid from ${currentCols} → ${desiredCols} columns first…`);
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: creds.sheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheetProps.sheetId,
                gridProperties: { columnCount: desiredCols },
              },
              fields: "gridProperties.columnCount",
            },
          },
        ],
      },
    });
  }

  // Re-read the tab so we pick up any headers that a prior partial run may
  // have written (idempotent — if linkedin already exists we won't add again).
  const refreshed = await readContactsTab(client, creds.sheetId, { tab: TARGET_TAB });
  let headers = refreshed.headers;
  const liCol = await ensureColumn(client, creds.sheetId, TARGET_TAB, headers, "linkedin", true);
  headers = liCol.headers;
  const igCol = await ensureColumn(client, creds.sheetId, TARGET_TAB, headers, "instagram", true);
  headers = igCol.headers;
  if (liCol.created) console.log(`Added column 'linkedin' at index ${liCol.index}.`);
  if (igCol.created) console.log(`Added column 'instagram' at index ${igCol.index}.`);

  const cellUpdates: CellUpdate[] = [];
  const before: Record<string, unknown>[] = [];
  const after: Record<string, unknown>[] = [];
  for (const p of plans.values()) {
    const sheetRow = p.rowIndex + 2; // +1 1-based, +1 header
    const liveRecord = target.rows[p.rowIndex]?.record ?? {};
    const beforeRow: Record<string, string> = {};
    const afterRow: Record<string, string> = {};
    if (p.linkedin) {
      cellUpdates.push({ range: `${TARGET_TAB}!${colLetter(liCol.index)}${sheetRow}`, value: p.linkedin });
      beforeRow.linkedin = liveRecord.linkedin ?? "";
      afterRow.linkedin = p.linkedin;
    }
    if (p.instagram) {
      cellUpdates.push({ range: `${TARGET_TAB}!${colLetter(igCol.index)}${sheetRow}`, value: p.instagram });
      beforeRow.instagram = liveRecord.instagram ?? "";
      afterRow.instagram = p.instagram;
    }
    if (Object.keys(afterRow).length > 0) {
      before.push({ row_index: p.rowIndex, full_name: p.fullName, values: beforeRow });
      after.push({ row_index: p.rowIndex, full_name: p.fullName, values: afterRow });
    }
  }

  console.log(`\nApplying ${cellUpdates.length} cell write(s)...`);
  const sessionId = newSessionId();
  await withChangelog(
    {
      caller: "script:backfill-social-from-export",
      sessionId,
      operation: OP,
      targetKind: "contact_rows",
      targetId: `${TARGET_TAB}!bulk[${plans.size}]`,
      intent: `restore linkedin/instagram URLs from ${SOURCE_TAB} for LinkedIn Connections + Instagram Contacts groups`,
      before: { tab: TARGET_TAB, source: SOURCE_TAB, rows: before },
      after: { tab: TARGET_TAB, source: SOURCE_TAB, rows: after },
      externalTarget: `google.sheet:${creds.sheetId}!${TARGET_TAB}`,
    },
    async () => {
      await batchUpdateCells(client, creds.sheetId, cellUpdates);
    },
  );
  console.log(`Done. Changelog session_id: ${sessionId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
