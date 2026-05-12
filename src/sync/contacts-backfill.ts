import type { OAuth2Client } from "google-auth-library";
import { withChangelog, newSessionId } from "../changelog/index.js";
import {
  appendRows,
  batchUpdateCells,
  colLetter,
  type CellUpdate,
} from "../integrations/google/sheets.js";
import type { RefreshOp, SyncPlan } from "./contacts.js";

const RESOURCE_NAME_COL = "google_resource_name";
export const BACKFILL_OP = "contacts.backfill_resource_name";
export const TIER_A_INSERT_OP = "contacts.tier_a_insert";
export const FORMATTING_REFRESH_OP = "contacts.formatting_refresh";

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

/**
 * Auto-apply Google-contact inserts as Tier-A benign writes. The new row
 * lands in dex_contacts with `groups` empty — that's the new pending-
 * review state, surfaced by the audit panel. The row carries identity fields
 * (full_name, emails, phones, company, etc.) from Google.
 *
 * Logged as a single changelog entry capturing every inserted row so the
 * session-level Undo can roll the whole batch back if Google's data turns
 * out to be wrong.
 */
export async function applyInsertsTierA(
  client: OAuth2Client,
  plan: SyncPlan,
): Promise<void> {
  if (plan.inserts.length === 0) return;
  const rows = plan.inserts.map((ins) => ins.values);
  const summary = plan.inserts.map((ins) => ({
    resource_name: ins.person.resource_name,
    display_name: ins.person.display_name,
    primary_email: ins.person.emails[0] ?? null,
    primary_phone: ins.person.phones[0] ?? null,
  }));
  await withChangelog(
    {
      caller: "sync:contacts.tier-a-inserts",
      sessionId: newSessionId(),
      operation: TIER_A_INSERT_OP,
      targetKind: "contact_rows",
      targetId: `${plan.tab}!append[${plan.inserts.length}]`,
      intent: `auto-insert ${plan.inserts.length} new Google contact(s) into ${plan.tab} (no groups → pending review)`,
      before: { tab: plan.tab, count: plan.inserts.length },
      after: { tab: plan.tab, headers: plan.headers, inserted: summary },
      externalTarget: `google.sheet:${plan.spreadsheetId}!${plan.tab}:append`,
    },
    async () => {
      await appendRows(client, plan.spreadsheetId, plan.tab, rows);
    },
  );
}

/**
 * Apply refresh ops whose changes are entirely formatting-only — phone
 * reformatting (same digits, different punctuation), description whitespace
 * restoration, resource_name backfill, updated_at touch. Treated as Tier-A
 * benign writes because no information is changed, only its representation.
 *
 * Single changelog entry per batch with the full before/after for each row,
 * so the session-level Undo can roll the whole sweep back if it turns out
 * a "formatting" change wasn't as benign as classified.
 */
export async function applyFormattingRefreshes(
  client: OAuth2Client,
  plan: SyncPlan,
  refreshes: RefreshOp[],
): Promise<void> {
  if (refreshes.length === 0) return;
  const cellUpdates: CellUpdate[] = [];
  const rowSummaries: Array<{
    row_index: number;
    resource_name: string;
    updates: Array<{ col: string; from: string; to: string }>;
  }> = [];
  for (const op of refreshes) {
    const sheetRow = op.rowIndex + 2; // +1 1-based, +1 header
    const rowUpdates: Array<{ col: string; from: string; to: string }> = [];
    for (const change of op.updates) {
      const colIdx = plan.headers.indexOf(change.col);
      if (colIdx === -1) continue;
      cellUpdates.push({
        range: `${plan.tab}!${colLetter(colIdx)}${sheetRow}`,
        value: change.to,
      });
      rowUpdates.push({ col: change.col, from: change.from, to: change.to });
    }
    rowSummaries.push({
      row_index: op.rowIndex,
      resource_name: op.person.resource_name,
      updates: rowUpdates,
    });
  }
  if (cellUpdates.length === 0) return;

  await withChangelog(
    {
      caller: "sync:contacts.formatting-refreshes",
      sessionId: newSessionId(),
      operation: FORMATTING_REFRESH_OP,
      targetKind: "contact_rows",
      targetId: `${plan.tab}!bulk[${refreshes.length}]`,
      intent: `auto-apply ${refreshes.length} formatting-only refresh(es) (phone/description/timestamp)`,
      before: {
        tab: plan.tab,
        rows: rowSummaries.map((r) => ({
          row_index: r.row_index,
          resource_name: r.resource_name,
          values: Object.fromEntries(r.updates.map((u) => [u.col, u.from])),
        })),
      },
      after: {
        tab: plan.tab,
        rows: rowSummaries.map((r) => ({
          row_index: r.row_index,
          resource_name: r.resource_name,
          values: Object.fromEntries(r.updates.map((u) => [u.col, u.to])),
        })),
      },
      externalTarget: `google.sheet:${plan.spreadsheetId}!${plan.tab}`,
    },
    async () => {
      await batchUpdateCells(client, plan.spreadsheetId, cellUpdates);
    },
  );
}
