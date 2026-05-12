import type { OAuth2Client } from "google-auth-library";
import { listAllConnections, type GooglePerson } from "../integrations/google/people.js";
import {
  appendRows,
  batchUpdateCells,
  colLetter,
  readContactsTab,
  setHeaderCell,
  type CellUpdate,
  type ContactsTab,
} from "../integrations/google/sheets.js";
import { buildSheetIndex, findMatch } from "./match.js";

const RESOURCE_NAME_COL = "google_resource_name";

/**
 * Identity columns we refresh from Google. New canonical names plus legacy
 * dex_-prefixed and `linkedin` aliases so syncs work both before and after
 * the one-time column-cleanup migration. Enrichment columns (groups, tags,
 * starred, archived, location, etc.) are never written by sync regardless
 * of state.
 */
const IDENTITY_COLUMNS = [
  // new canonical names (post-cleanup)
  "full_name",
  "first_name",
  "last_name",
  "description",
  "birthday",
  "birthday_year",
  "job_title",
  "company",
  "image_url",
  "linkedin_url",
  "website",
  "email",
  "emails",
  "phone",
  "phones",
  "address",
  // legacy names (pre-cleanup) — kept so a sync mid-migration writes to whichever set exists
  "linkedin",
  "dex_email",
  "dex_emails",
  "dex_phone",
  "dex_phones",
  "dex_address",
] as const;

type IdentityCol = (typeof IDENTITY_COLUMNS)[number];

export type FieldChange = { col: string; from: string; to: string };

export type RefreshOp = {
  rowIndex: number;
  person: GooglePerson;
  via: "resource_name" | "email" | "phone";
  updates: FieldChange[];
};

export type InsertOp = {
  person: GooglePerson;
  /** values aligned with the extended headers (google_resource_name appended if needed) */
  values: string[];
};

export type AmbiguousOp = {
  person: GooglePerson;
  matches: number[];
  via: "email" | "phone";
};

export type SyncPlan = {
  spreadsheetId: string;
  tab: string;
  headers: string[];
  /** true when the Sheet was missing google_resource_name and we will append it */
  needsHeaderUpdate: boolean;
  resourceNameColIndex: number;
  inserts: InsertOp[];
  refreshes: RefreshOp[];
  ambiguous: AmbiguousOp[];
  unchanged: number;
};

export type SyncSummary = {
  inserted: number;
  refreshed: number;
  unchanged: number;
  ambiguous: number;
};

function personToIdentity(p: GooglePerson): Record<IdentityCol, string> {
  const primaryEmail = p.emails[0] ?? "";
  const allEmails = p.emails.join(", ");
  const primaryPhone = p.phones[0] ?? "";
  const allPhones = p.phones.join(", ");
  const linkedin = p.linkedin_url ?? "";
  const address = p.address ?? "";
  return {
    full_name: p.display_name ?? "",
    first_name: p.given_name ?? "",
    last_name: p.family_name ?? "",
    description: p.biography ?? "",
    birthday: p.birthday ?? "",
    birthday_year: p.birthday_year !== null ? String(p.birthday_year) : "",
    job_title: p.job_title ?? "",
    company: p.company ?? "",
    image_url: p.image_url ?? "",
    website: p.website ?? "",
    // new canonical
    linkedin_url: linkedin,
    email: primaryEmail,
    emails: allEmails,
    phone: primaryPhone,
    phones: allPhones,
    address,
    // legacy aliases — same values, different column names
    linkedin,
    dex_email: primaryEmail,
    dex_emails: allEmails,
    dex_phone: primaryPhone,
    dex_phones: allPhones,
    dex_address: address,
  };
}

/**
 * Compute changes for a matched row. Empty Google values do NOT overwrite
 * non-empty Sheet values — preserves manually-added Sheet data when Google
 * has no value for that field. Always sets google_resource_name and
 * updated_at when they differ from current. Only proposes updates for
 * columns actually present in the Sheet's headers.
 */
function computeRefreshChanges(
  current: Record<string, string>,
  person: GooglePerson,
  nowIso: string,
  headerSet: Set<string>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const identity = personToIdentity(person);
  for (const col of IDENTITY_COLUMNS) {
    if (!headerSet.has(col)) continue;
    const newVal = identity[col];
    const oldVal = current[col] ?? "";
    if (newVal !== "" && newVal !== oldVal) {
      changes.push({ col, from: oldVal, to: newVal });
    }
  }
  if (headerSet.has(RESOURCE_NAME_COL)) {
    const oldResource = current[RESOURCE_NAME_COL] ?? "";
    if (person.resource_name && oldResource !== person.resource_name) {
      changes.push({ col: RESOURCE_NAME_COL, from: oldResource, to: person.resource_name });
    }
  }
  if (changes.length > 0 && headerSet.has("updated_at")) {
    const oldUpdated = current.updated_at ?? "";
    if (oldUpdated !== nowIso) {
      changes.push({ col: "updated_at", from: oldUpdated, to: nowIso });
    }
  }
  return changes;
}

function buildInsertRow(headers: string[], person: GooglePerson, nowIso: string): string[] {
  const identity = personToIdentity(person);
  return headers.map((h) => {
    if (h === RESOURCE_NAME_COL) return person.resource_name;
    if (h === "created_at" || h === "updated_at") return nowIso;
    if (h in identity) return (identity as Record<string, string>)[h];
    return "";
  });
}

export function planSync(
  spreadsheetId: string,
  contactsTab: ContactsTab,
  people: GooglePerson[],
  nowIso: string,
): SyncPlan {
  const headers = [...contactsTab.headers];
  // If the sheet doesn't have google_resource_name, we don't auto-re-add it —
  // dropping the column was an explicit user choice. Matching falls back to
  // email/phone via findMatch().
  const resourceNameColIndex = headers.indexOf(RESOURCE_NAME_COL);
  const needsHeaderUpdate = false;

  const idx = buildSheetIndex(contactsTab.rows);
  const headerSet = new Set(headers);

  const inserts: InsertOp[] = [];
  const refreshes: RefreshOp[] = [];
  const ambiguous: AmbiguousOp[] = [];
  let unchanged = 0;

  for (const person of people) {
    if (!person.resource_name) continue;
    const match = findMatch(person, idx);
    if (match.kind === "ambiguous") {
      ambiguous.push({ person, matches: match.matches, via: match.via });
      continue;
    }
    if (match.kind === "none") {
      inserts.push({ person, values: buildInsertRow(headers, person, nowIso) });
      continue;
    }
    const row = contactsTab.rows.find((r) => r.rowIndex === match.rowIndex);
    if (!row) continue;
    const updates = computeRefreshChanges(row.record, person, nowIso, headerSet);
    if (updates.length === 0) {
      unchanged++;
    } else {
      refreshes.push({ rowIndex: match.rowIndex, person, via: match.kind, updates });
    }
  }

  return {
    spreadsheetId,
    tab: contactsTab.tab,
    headers,
    needsHeaderUpdate,
    resourceNameColIndex,
    inserts,
    refreshes,
    ambiguous,
    unchanged,
  };
}

export function summarize(plan: SyncPlan): SyncSummary {
  return {
    inserted: plan.inserts.length,
    refreshed: plan.refreshes.length,
    unchanged: plan.unchanged,
    ambiguous: plan.ambiguous.length,
  };
}

export async function applySyncPlan(client: OAuth2Client, plan: SyncPlan): Promise<void> {
  if (plan.needsHeaderUpdate) {
    await setHeaderCell(client, plan.spreadsheetId, plan.tab, plan.resourceNameColIndex, RESOURCE_NAME_COL);
  }

  if (plan.refreshes.length > 0) {
    const cellUpdates: CellUpdate[] = [];
    for (const refresh of plan.refreshes) {
      const sheetRow = refresh.rowIndex + 2; // +1 for 1-based, +1 for header
      for (const change of refresh.updates) {
        const colIdx = plan.headers.indexOf(change.col);
        if (colIdx === -1) continue;
        cellUpdates.push({
          range: `${plan.tab}!${colLetter(colIdx)}${sheetRow}`,
          value: change.to,
        });
      }
    }
    await batchUpdateCells(client, plan.spreadsheetId, cellUpdates);
  }

  if (plan.inserts.length > 0) {
    const rows = plan.inserts.map((ins) => ins.values);
    await appendRows(client, plan.spreadsheetId, plan.tab, rows);
  }
}

export type RunSyncMode = "queue" | "apply";

export type EnqueueResult = {
  queued_inserts: number;
  queued_refreshes: number;
  queued_ambiguous: number;
  skipped_duplicates: number;
};

export type RunSyncResult = {
  plan: SyncPlan;
  summary: SyncSummary;
  applied: boolean;
  /** Counts when mode='queue' (default) and dryRun=false. */
  queued?: EnqueueResult;
};

/**
 * Default behavior: pull contacts + diff against the sheet, then enqueue every
 * insert/refresh/ambiguous as a `needs_review` row. No direct sheet writes
 * happen except the one-time header-column migration (adding
 * `google_resource_name` when missing). Approving the queued reviews from the
 * UI applies the actual sheet writes via the registered contact appliers.
 *
 * Pass `mode: "apply"` to bypass the review queue (matches the pre-2026-05-12
 * behavior — kept for tests and migrations).
 */
export async function runSync(
  client: OAuth2Client,
  spreadsheetId: string,
  opts: {
    dryRun: boolean;
    tab?: string;
    nowIso?: string;
    mode?: RunSyncMode;
  } = { dryRun: true },
): Promise<RunSyncResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const mode: RunSyncMode = opts.mode ?? "queue";
  const [people, contactsTab] = await Promise.all([
    listAllConnections(client),
    readContactsTab(client, spreadsheetId, { tab: opts.tab }),
  ]);
  const plan = planSync(spreadsheetId, contactsTab, people, nowIso);
  const summary = summarize(plan);
  if (opts.dryRun) {
    return { plan, summary, applied: false };
  }
  if (mode === "apply") {
    await applySyncPlan(client, plan);
    return { plan, summary, applied: true };
  }
  // mode === "queue" — enqueue review rows, do header migration if needed.
  if (plan.needsHeaderUpdate) {
    await setHeaderCell(
      client,
      plan.spreadsheetId,
      plan.tab,
      plan.resourceNameColIndex,
      RESOURCE_NAME_COL,
    );
  }
  const { enqueueSyncPlan } = await import("./contacts-review.js");
  const queued = await enqueueSyncPlan(plan);
  return { plan, summary, applied: false, queued };
}
