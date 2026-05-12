import type { OAuth2Client } from "google-auth-library";
import { withChangelog } from "../changelog/index.js";
import { reviewAppliers } from "../needs-review/appliers.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import {
  appendRows,
  batchUpdateCells,
  colLetter,
  type CellUpdate,
} from "../integrations/google/sheets.js";
import {
  CONTACT_AMBIGUOUS_KIND,
  CONTACT_INSERT_KIND,
  CONTACT_REFRESH_KIND,
  type ContactReviewAction,
} from "./contacts-review.js";

export const CONTACT_INSERT_OP = "contacts.review.insert";
export const CONTACT_REFRESH_OP = "contacts.review.refresh";

export function registerContactReviewAppliers(
  client: OAuth2Client,
  opts: { spreadsheetId: string },
): void {
  reviewAppliers.register(CONTACT_INSERT_KIND, async (subjectId, decision, meta) => {
    const action = decision as ContactReviewAction;
    if (action.type !== "insert") {
      throw new Error(`expected insert action, got ${action.type}`);
    }
    await enforceConfiguredDailyLimit(CONTACT_INSERT_OP);
    await withChangelog(
      {
        caller: meta.caller,
        sessionId: meta.sessionId,
        operation: CONTACT_INSERT_OP,
        targetKind: "contact",
        targetId: subjectId,
        intent: meta.intent ?? "approve insert from contacts review",
        before: {},
        after: { tab: action.tab, values: action.values },
        externalTarget: `google.sheet:${opts.spreadsheetId}!${action.tab}:append`,
      },
      async () => {
        await appendRows(client, opts.spreadsheetId, action.tab, [action.values]);
      },
    );
    return { inserted: true, tab: action.tab, columns: action.headers.length };
  });

  reviewAppliers.register(CONTACT_REFRESH_KIND, async (subjectId, decision, meta) => {
    const action = decision as ContactReviewAction;
    if (action.type !== "refresh") {
      throw new Error(`expected refresh action, got ${action.type}`);
    }
    await enforceConfiguredDailyLimit(CONTACT_REFRESH_OP);

    // Re-read the sheet and find the row by google_resource_name (== subjectId)
    // rather than trusting action.row_index, which was captured at queue time
    // and may be stale if the user has inserted/deleted/sorted rows since.
    const { readContactsTab } = await import("../integrations/google/sheets.js");
    const tab = await readContactsTab(client, opts.spreadsheetId, { tab: action.tab });
    const live = tab.rows.find((r) => (r.record["google_resource_name"] ?? "") === subjectId);
    if (!live) {
      throw new Error(
        `contact "${subjectId}" not found in tab "${action.tab}" (row deleted or moved between queue and apply)`,
      );
    }
    const liveRowIndex = live.rowIndex;
    const sheetRow = liveRowIndex + 2; // +1 for 1-based, +1 for header

    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    const cellUpdates: CellUpdate[] = [];
    for (const change of action.updates) {
      const idx = tab.headers.indexOf(change.col);
      if (idx === -1) continue;
      cellUpdates.push({
        range: `${action.tab}!${colLetter(idx)}${sheetRow}`,
        value: change.to,
      });
      // Snapshot the *live* before-value, not the captured one, so the
      // changelog reflects what actually got overwritten.
      before[change.col] = live.record[change.col] ?? "";
      after[change.col] = change.to;
    }
    if (cellUpdates.length === 0) {
      return {
        refreshed: 0,
        tab: action.tab,
        row_index: liveRowIndex,
        reason: "no matching columns",
      };
    }
    await withChangelog(
      {
        caller: meta.caller,
        sessionId: meta.sessionId,
        operation: CONTACT_REFRESH_OP,
        targetKind: "contact",
        targetId: subjectId,
        intent: meta.intent ?? `approve refresh row ${liveRowIndex}`,
        before,
        after,
        externalTarget: `google.sheet:${opts.spreadsheetId}!${action.tab}!row${liveRowIndex}`,
      },
      async () => {
        await batchUpdateCells(client, opts.spreadsheetId, cellUpdates);
      },
    );
    return {
      refreshed: cellUpdates.length,
      tab: action.tab,
      row_index: liveRowIndex,
    };
  });

  reviewAppliers.register(CONTACT_AMBIGUOUS_KIND, async () => {
    throw new Error(
      "ambiguous contacts can't be approved directly — clean up the duplicate sheet rows via the audit panel first, then re-run sync",
    );
  });
}
