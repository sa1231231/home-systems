/**
 * One-shot: sweep the pending google_contact_refresh queue, classify each as
 * formatting-only (phone reformat / description whitespace / resource_name
 * backfill / updated_at touch) or "real", and auto-apply the formatting ones.
 * Marks the corresponding needs_review rows as approved with a
 * decision={ auto_formatting: true }.
 *
 *   $ npx tsx scripts/auto-apply-formatting-refreshes.ts          # dry run
 *   $ npx tsx scripts/auto-apply-formatting-refreshes.ts --apply  # execute
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { needsReview } from "../src/db/schema.js";
import { newSessionId, withChangelog } from "../src/changelog/index.js";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import {
  batchUpdateCells,
  colLetter,
  readContactsTab,
  type CellUpdate,
} from "../src/integrations/google/sheets.js";
import { getConfig } from "../src/config.js";
import { FORMATTING_REFRESH_OP } from "../src/sync/contacts-backfill.js";

const RESOURCE_NAME_COL = "google_resource_name";

type FieldChange = { col: string; from: string; to: string };
type RefreshAction = {
  type: "refresh";
  tab: string;
  row_index: number;
  via: string;
  updates: FieldChange[];
};

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}
function normalizePhoneCsv(s: string): string {
  return s
    .split(/[,;]/)
    .map((p) => {
      const digits = p.replace(/\D/g, "");
      return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    })
    .filter((p) => p.length > 0)
    .sort()
    .join(",");
}
function isFormattingOnlyChange(change: FieldChange): boolean {
  if (change.col === RESOURCE_NAME_COL) return change.from === "";
  if (change.col === "updated_at") return true;
  if (change.col === "phone" || change.col === "phones") {
    return normalizePhoneCsv(change.from) === normalizePhoneCsv(change.to);
  }
  if (change.col === "description") {
    return stripWhitespace(change.from) === stripWhitespace(change.to);
  }
  return false;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const creds = requireGoogleCreds();
  const client = getOAuthClient();
  const targetTab = getConfig().CONTACTS_TAB;

  const pending = await db
    .select()
    .from(needsReview)
    .where(
      and(
        eq(needsReview.domain, "contact"),
        eq(needsReview.subjectKind, "google_contact_refresh"),
        eq(needsReview.status, "pending"),
      ),
    );

  // Bucket pending by target tab — only handle ones targeting the active tab.
  const onTarget = pending.filter(
    (r) => ((r.proposedAction as RefreshAction | null)?.tab ?? "") === targetTab,
  );
  const offTarget = pending.length - onTarget.length;

  const formattingOnly: typeof pending = [];
  const real: typeof pending = [];
  for (const row of onTarget) {
    const action = row.proposedAction as RefreshAction | null;
    if (!action || action.type !== "refresh" || !action.updates) continue;
    if (action.updates.length === 0) continue;
    if (action.updates.every(isFormattingOnlyChange)) formattingOnly.push(row);
    else real.push(row);
  }

  console.log(`Pending refresh reviews: ${pending.length}`);
  console.log(`  off-target tab (skipped):           ${offTarget}`);
  console.log(`  on-target, formatting-only:         ${formattingOnly.length}`);
  console.log(`  on-target, real field changes:      ${real.length}`);
  console.log();
  console.log(`Mode: ${apply ? "APPLY" : "dry run (use --apply to execute)"}`);
  console.log();

  if (formattingOnly.length === 0) {
    console.log("Nothing to auto-apply.");
    return;
  }

  // Print a few samples so the user can sanity-check the classifier.
  console.log("Sample formatting-only refreshes (first 3):");
  for (const r of formattingOnly.slice(0, 3)) {
    const a = r.proposedAction as RefreshAction;
    console.log(`  [review #${r.id}] ${r.subjectId} via ${a.via}`);
    for (const u of a.updates) console.log(`    ${u.col}: ${JSON.stringify(u.from)} → ${JSON.stringify(u.to)}`);
  }
  console.log();

  if (!apply) {
    console.log(`Would auto-apply ${formattingOnly.length} refreshes and mark them approved.`);
    return;
  }

  // Re-resolve each row against the LIVE sheet. Resolution priority:
  //   1. google_resource_name (if already bound)
  //   2. captured row_index in the proposedAction (these reviews were
  //      queued at sync time; if no rows have been inserted/deleted since
  //      then the captured index is still valid)
  // We additionally guard: only apply if the live row's current cell value
  // matches the proposedAction's `from` value. If they differ, something
  // else changed the row in the meantime — skip and let the user review.
  const liveTab = await readContactsTab(client, creds.sheetId, { tab: targetTab });
  const byResource = new Map<string, { rowIndex: number; record: Record<string, string> }>();
  for (const r of liveTab.rows) {
    const rn = (r.record[RESOURCE_NAME_COL] ?? "").trim();
    if (rn) byResource.set(rn, r);
  }

  const cellUpdates: CellUpdate[] = [];
  const before: Record<string, unknown>[] = [];
  const after: Record<string, unknown>[] = [];
  const approvedIds: number[] = [];
  let skippedMissing = 0;
  let skippedDrift = 0;
  for (const review of formattingOnly) {
    const action = review.proposedAction as RefreshAction;
    const subjectId = review.subjectId;
    let live = subjectId ? byResource.get(subjectId) : undefined;
    if (!live && typeof action.row_index === "number") {
      live = liveTab.rows[action.row_index];
    }
    if (!live) {
      skippedMissing++;
      continue;
    }
    // Drift guard: each change's `from` must still match the live cell.
    // Skip the whole review if any change has drifted.
    let drifted = false;
    for (const change of action.updates) {
      const currentVal = live.record[change.col] ?? "";
      if (currentVal !== change.from) {
        drifted = true;
        break;
      }
    }
    if (drifted) {
      skippedDrift++;
      continue;
    }
    const sheetRow = live.rowIndex + 2; // +1 1-based, +1 header
    const rowBefore: Record<string, string> = {};
    const rowAfter: Record<string, string> = {};
    for (const change of action.updates) {
      const colIdx = liveTab.headers.indexOf(change.col);
      if (colIdx === -1) continue;
      cellUpdates.push({
        range: `${targetTab}!${colLetter(colIdx)}${sheetRow}`,
        value: change.to,
      });
      rowBefore[change.col] = live.record[change.col] ?? "";
      rowAfter[change.col] = change.to;
    }
    before.push({ review_id: review.id, resource_name: subjectId, row_index: live.rowIndex, values: rowBefore });
    after.push({ review_id: review.id, resource_name: subjectId, row_index: live.rowIndex, values: rowAfter });
    approvedIds.push(review.id);
  }

  if (cellUpdates.length === 0) {
    console.log(`No live matches; ${skippedMissing} review(s) referenced rows that no longer exist.`);
    return;
  }

  const sessionId = newSessionId();
  await withChangelog(
    {
      caller: "script:auto-apply-formatting-refreshes",
      sessionId,
      operation: FORMATTING_REFRESH_OP,
      targetKind: "contact_rows",
      targetId: `${targetTab}!bulk[${approvedIds.length}]`,
      intent: `sweep: auto-apply ${approvedIds.length} pre-existing formatting-only refresh reviews`,
      before: { tab: targetTab, rows: before },
      after: { tab: targetTab, rows: after },
      externalTarget: `google.sheet:${creds.sheetId}!${targetTab}`,
    },
    async () => {
      await batchUpdateCells(client, creds.sheetId, cellUpdates);
    },
  );

  // Mark the reviews approved in batches of 500.
  for (let i = 0; i < approvedIds.length; i += 500) {
    const batch = approvedIds.slice(i, i + 500);
    await db
      .update(needsReview)
      .set({
        status: "approved",
        decision: { auto_formatting: true, sessionId } as never,
        decidedAt: new Date(),
        decidedBy: "script:auto-apply-formatting-refreshes",
        updatedAt: new Date(),
      })
      .where(inArray(needsReview.id, batch));
  }

  console.log(`Applied ${approvedIds.length} formatting refreshes.`);
  console.log(`Skipped ${skippedMissing} review(s) whose row no longer exists.`);
  console.log(`Skipped ${skippedDrift} review(s) where the live cell drifted since queue time.`);
  console.log(`Changelog session_id: ${sessionId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
