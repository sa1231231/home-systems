import type { OAuth2Client } from "google-auth-library";
import { listConnectionsDelta, type GooglePerson } from "../integrations/google/people.js";
import { getMeta, setMeta } from "../db/meta.js";
import {
  appendRows,
  batchUpdateCells,
  colLetter,
  readContactsTab,
  setHeaderCell,
  type CellUpdate,
  type ContactsTab,
} from "../integrations/google/sheets.js";
import { findCompanyDndbRows } from "./contacts-audit.js";
import { buildSheetIndex, findMatch } from "./match.js";
import {
  deleteSnapshots,
  loadSnapshots,
  writeSnapshots,
  type SnapshotFields,
} from "./contact-snapshots.js";

const RESOURCE_NAME_COL = "google_resource_name";

/** `_meta` key holding the People API sync token for incremental fetches. */
const SYNC_TOKEN_KEY = "contacts.sync_token";

/**
 * Identity columns sync refreshes from Google. Stripped down post-2026-05-12
 * to just the fields the dex_contacts CRM actually keeps. Enrichment columns
 * (groups, tags) are never written by sync — they're the user's domain.
 */
export const IDENTITY_COLUMNS = [
  "full_name",
  "description",
  "job_title",
  "company",
  "website",
  "email",
  "emails",
  "phone",
  "phones",
  "address",
  "birthday",
] as const;

type IdentityCol = (typeof IDENTITY_COLUMNS)[number];

/**
 * Identity columns that sync will auto-append to the sheet header if missing.
 * Without this, the sync silently skips columns the sheet doesn't have —
 * fine for legacy columns the user may have deleted on purpose, but for
 * newly-added sync targets (like `birthday`) we want one nightly run to be
 * enough to make the column appear.
 */
const AUTO_ADD_IDENTITY_COLUMNS: readonly IdentityCol[] = ["birthday"];

/**
 * - `auto`: Google changed, the sheet field is untouched since last sync —
 *   safe to apply without review. Also covers the schema-extension case
 *   where a newly-added identity column is being backfilled into a sheet
 *   cell that's still empty.
 * - `conflict`: both Google and the sheet changed since last sync — must be
 *   reviewed (applying would overwrite a hand edit).
 * - `first_run`: no baseline snapshot for this contact yet — review to be safe.
 */
export type ChangeTier = "auto" | "conflict" | "first_run";

export type FieldChange = {
  col: string;
  /** Current sheet value. */
  from: string;
  /** Proposed (current Google) value. */
  to: string;
  /** Last-synced Google value (snapshot baseline), when known. */
  base?: string;
  tier: ChangeTier;
};

export type RefreshOp = {
  rowIndex: number;
  person: GooglePerson;
  via: "resource_name" | "email" | "phone" | "name" | "name_weak";
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
  via: "email" | "phone" | "name";
};

export type SyncPlan = {
  spreadsheetId: string;
  tab: string;
  headers: string[];
  /** True when at least one header was missing from the sheet and will be
   *  appended on apply (kept as a boolean for back-compat with the JSON API). */
  needsHeaderUpdate: boolean;
  resourceNameColIndex: number;
  /** All headers (with their target column index) that this plan will append
   *  to the sheet — currently `google_resource_name` and any column listed in
   *  AUTO_ADD_IDENTITY_COLUMNS that's missing. */
  headersAppended: Array<{ name: string; colIndex: number }>;
  inserts: InsertOp[];
  refreshes: RefreshOp[];
  ambiguous: AmbiguousOp[];
  unchanged: number;
  /** Matched contacts with no proposed changes — used to seed missing snapshots. */
  unchangedPersons: GooglePerson[];
  /** Google contacts whose row was previously synced (has a snapshot) but is
   *  no longer in the sheet — user deleted the row, so we suppress the
   *  would-be insert instead of resurrecting it. */
  tombstoned: GooglePerson[];
};

export type SyncSummary = {
  inserted: number;
  refreshed: number;
  unchanged: number;
  ambiguous: number;
  /** Inserts suppressed because the user previously deleted that sheet row. */
  tombstoned: number;
};

export function personToIdentity(p: GooglePerson): Record<IdentityCol, string> {
  const primaryEmail = p.emails[0] ?? "";
  const allEmails = p.emails.join(", ");
  const primaryPhone = p.phones[0] ?? "";
  const allPhones = p.phones.join(", ");
  return {
    full_name: p.display_name ?? "",
    description: p.biography ?? "",
    job_title: p.job_title ?? "",
    company: p.company ?? "",
    website: p.website ?? "",
    email: primaryEmail,
    emails: allEmails,
    phone: primaryPhone,
    phones: allPhones,
    address: p.address ?? "",
    // YYYY-MM-DD when Google has the year, MM-DD when it doesn't.
    // Empty Google birthdays never overwrite a sheet value (see
    // computeRefreshChanges' empty-google guard).
    birthday: p.birthday ?? "",
  };
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Collapse whitespace + comma separators — Google (newline-separated) vs
 *  Dex (comma-joined) address formatting should compare equal. */
function normalizeAddress(s: string): string {
  return s.replace(/[\s,]+/g, " ").trim().toLowerCase();
}

/** Phone or CSV-of-phones reduced to a sorted, deduped set of bare digit
 *  strings (leading US "1" dropped) — `+1 555-1234`, `5551234`, and a
 *  list with the same number twice all compare equal. */
function normalizePhoneCsv(s: string): string {
  const set = new Set<string>();
  for (const piece of s.split(/[,;]/)) {
    const digits = piece.replace(/\D/g, "");
    const trimmed = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort().join(",");
}

/** Email or CSV-of-emails reduced to a sorted, deduped, lowercased set —
 *  treats case, spacing, ordering and duplicate entries as formatting. */
function normalizeEmailCsv(s: string): string {
  const set = new Set<string>();
  for (const piece of s.split(/[,;]/)) {
    const e = piece.trim().toLowerCase();
    if (e) set.add(e);
  }
  return [...set].sort().join(",");
}

/**
 * True when two values for a column carry the same information and differ
 * only in formatting — phone format/order/duplicates, email spacing/case/
 * duplicates, whitespace, address punctuation. Such a difference is not a
 * real content change and should never surface as a sync change.
 */
export function fieldEquiv(col: string, a: string, b: string): boolean {
  if (a === b) return true;
  if (col === "phone" || col === "phones") return normalizePhoneCsv(a) === normalizePhoneCsv(b);
  if (col === "email" || col === "emails") return normalizeEmailCsv(a) === normalizeEmailCsv(b);
  if (col === "description") return stripWhitespace(a) === stripWhitespace(b);
  if (col === "address") return normalizeAddress(a) === normalizeAddress(b);
  return a.trim() === b.trim();
}

/**
 * Compute changes for a matched row via a 3-way compare — Google-now vs
 * Sheet-now vs the last-synced snapshot (`base`). Empty Google values never
 * overwrite the Sheet, and formatting-only differences (see `fieldEquiv`)
 * are ignored. A field is only emitted as a change when Google
 * actually moved since last sync; each change is tiered:
 *   - Google moved, sheet still == base  → `auto`  (safe to apply)
 *   - Google moved, sheet also moved     → `conflict` (must be reviewed)
 *   - no snapshot for this contact yet   → `first_run` (review to be safe)
 * When Google has NOT moved (`google == base`) the field is left entirely
 * alone, preserving any hand edit in the sheet. `google_resource_name` and
 * `updated_at` are mechanical and always tiered `auto`.
 */
function computeRefreshChanges(
  current: Record<string, string>,
  person: GooglePerson,
  nowIso: string,
  headerSet: Set<string>,
  snapshot: SnapshotFields | undefined,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const identity = personToIdentity(person);
  for (const col of IDENTITY_COLUMNS) {
    if (!headerSet.has(col)) continue;
    const googleNow = identity[col];
    const sheetNow = current[col] ?? "";
    // Empty Google never overwrites the sheet; formatting-only differences
    // (reformatted phone, deduped list, whitespace) are not real changes.
    if (googleNow === "") continue;
    if (fieldEquiv(col, googleNow, sheetNow)) continue;
    const base = snapshot?.[col];
    let tier: ChangeTier;
    if (snapshot === undefined) {
      tier = "first_run";
    } else if (base === undefined) {
      // Schema extension: this contact has a snapshot (we've synced it
      // before) but no baseline for this column — it just joined
      // IDENTITY_COLUMNS. Backfilling into an empty sheet cell is safe to
      // auto-apply; a non-empty sheet cell is a hand edit, so conflict.
      tier = sheetNow === "" ? "auto" : "conflict";
    } else if (fieldEquiv(col, googleNow, base)) {
      // Google hasn't substantively moved since last sync — leave the sheet
      // (incl. any hand edit) untouched.
      continue;
    } else if (fieldEquiv(col, sheetNow, base)) {
      tier = "auto";
    } else {
      tier = "conflict";
    }
    changes.push({ col, from: sheetNow, to: googleNow, base, tier });
  }
  if (headerSet.has(RESOURCE_NAME_COL)) {
    const oldResource = current[RESOURCE_NAME_COL] ?? "";
    if (person.resource_name && oldResource !== person.resource_name) {
      changes.push({ col: RESOURCE_NAME_COL, from: oldResource, to: person.resource_name, tier: "auto" });
    }
  }
  if (changes.length > 0 && headerSet.has("updated_at")) {
    const oldUpdated = current.updated_at ?? "";
    if (oldUpdated !== nowIso) {
      changes.push({ col: "updated_at", from: oldUpdated, to: nowIso, tier: "auto" });
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
  snapshots: Map<string, SnapshotFields> = new Map(),
): SyncPlan {
  const headers = [...contactsTab.headers];
  const headersAppended: Array<{ name: string; colIndex: number }> = [];
  // Auto-add the google_resource_name column when missing. It's the stable
  // Google ID for each contact — the only reliable dedupe key. The column
  // can be hidden in the Sheets UI if it's visually noisy.
  let resourceNameColIndex = headers.indexOf(RESOURCE_NAME_COL);
  if (resourceNameColIndex === -1) {
    resourceNameColIndex = headers.length;
    headers.push(RESOURCE_NAME_COL);
    headersAppended.push({ name: RESOURCE_NAME_COL, colIndex: resourceNameColIndex });
  }
  // Identity columns we want sync to actually write — append if the sheet
  // doesn't yet have them. Lets newly-added sync targets (like `birthday`)
  // light up after one nightly run without manual sheet edits.
  for (const col of AUTO_ADD_IDENTITY_COLUMNS) {
    if (headers.indexOf(col) === -1) {
      const colIndex = headers.length;
      headers.push(col);
      headersAppended.push({ name: col, colIndex });
    }
  }
  const needsHeaderUpdate = headersAppended.length > 0;

  const idx = buildSheetIndex(contactsTab.rows);
  const headerSet = new Set(headers);

  // Set of google_resource_name values currently in the sheet. Combined with
  // snapshots (which exist for every contact we've previously synced), this
  // tells us "user deleted a synced row" — those re-inserts get suppressed
  // instead of resurrected. See `tombstoned` on SyncPlan.
  const sheetResourceNames = new Set<string>();
  for (const row of contactsTab.rows) {
    const rn = (row.record[RESOURCE_NAME_COL] ?? "").trim();
    if (rn) sheetResourceNames.add(rn);
  }

  const inserts: InsertOp[] = [];
  const refreshes: RefreshOp[] = [];
  const ambiguous: AmbiguousOp[] = [];
  const unchangedPersons: GooglePerson[] = [];
  const tombstoned: GooglePerson[] = [];

  for (const person of people) {
    if (!person.resource_name) continue;
    const match = findMatch(person, idx);
    if (match.kind === "ambiguous") {
      ambiguous.push({ person, matches: match.matches, via: match.via });
      continue;
    }
    if (match.kind === "none") {
      // Snapshot exists but no sheet row carries this resource_name → user
      // deleted the row in a prior session. Don't resurrect it.
      if (
        snapshots.has(person.resource_name) &&
        !sheetResourceNames.has(person.resource_name)
      ) {
        tombstoned.push(person);
        continue;
      }
      inserts.push({ person, values: buildInsertRow(headers, person, nowIso) });
      continue;
    }
    const row = contactsTab.rows.find((r) => r.rowIndex === match.rowIndex);
    if (!row) continue;
    const updates = computeRefreshChanges(
      row.record,
      person,
      nowIso,
      headerSet,
      snapshots.get(person.resource_name),
    );
    if (updates.length === 0) {
      unchangedPersons.push(person);
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
    headersAppended,
    inserts,
    refreshes,
    ambiguous,
    unchanged: unchangedPersons.length,
    unchangedPersons,
    tombstoned,
  };
}

export function summarize(plan: SyncPlan): SyncSummary {
  return {
    inserted: plan.inserts.length,
    refreshed: plan.refreshes.length,
    unchanged: plan.unchanged,
    ambiguous: plan.ambiguous.length,
    tombstoned: plan.tombstoned.length,
  };
}

export async function applySyncPlan(client: OAuth2Client, plan: SyncPlan): Promise<void> {
  for (const h of plan.headersAppended) {
    await setHeaderCell(client, plan.spreadsheetId, plan.tab, h.colIndex, h.name);
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
  /** Re-proposals blocked because the user previously rejected the same change. */
  blocked_by_prior_reject: number;
  /** Trivial refreshes that auto-applied (binding resource_name on already-matched rows). */
  resource_name_backfills: number;
  /** Refreshes where every change was formatting-only (phone/whitespace/etc.) — auto-applied. */
  formatting_refreshes: number;
  /** New rows auto-inserted into dex_contacts (Tier-A, no groups assigned). */
  auto_inserts: number;
  /** Rows whose company contained "D&DB" but tags didn't yet — sync auto-added DNDB. */
  company_dndb_tagged: number;
};

export type RunSyncResult = {
  plan: SyncPlan;
  summary: SyncSummary;
  applied: boolean;
  /** Counts when mode='queue' (default) and dryRun=false. */
  queued?: EnqueueResult;
};

/**
 * A refresh op whose only change is filling in google_resource_name on a
 * row that was already matched by email/phone/name. Binding the stable
 * Google ID is benign + reversible — auto-apply without queueing.
 */
function isResourceNameBackfill(op: RefreshOp): boolean {
  return op.updates.length === 1 && op.updates[0].col === RESOURCE_NAME_COL;
}

/** True iff every change in the op is `auto` tier (or a mechanical one). */
function isAutoApplicable(op: RefreshOp): boolean {
  return op.updates.every((u) => u.tier === "auto");
}

/**
 * Default behavior (dex_contacts era, post-2026-05-12):
 *
 * - **Inserts auto-apply** as Tier-A benign writes. A new Google contact
 *   lands in dex_contacts with `groups` empty — that empty cell IS the
 *   new "pending review" signal (the user assigns groups via the sheet/UI).
 * - **resource_name backfills** auto-apply (binding Google's stable ID to a
 *   row matched by email/phone/name — provably benign).
 * - **Field-diff refreshes** still go through the needs_review queue. The
 *   existing dex_contacts data is precious — never overwrite without
 *   explicit approval.
 * - **Ambiguous** matches still go through the queue.
 *
 * Pass `mode: "apply"` to bypass review for everything (tests/migrations).
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
  // Incremental fetch: with a stored sync token the People API returns only
  // contacts changed/deleted since last run. The sheet is still read whole —
  // matching needs the full index.
  const storedToken = await getMeta(SYNC_TOKEN_KEY);
  const [delta, contactsTab] = await Promise.all([
    listConnectionsDelta(client, { syncToken: storedToken }),
    readContactsTab(client, spreadsheetId, { tab: opts.tab }),
  ]);
  const people = delta.persons;
  const snapshots = await loadSnapshots(people.map((p) => p.resource_name).filter(Boolean));
  const plan = planSync(spreadsheetId, contactsTab, people, nowIso, snapshots);
  const summary = summarize(plan);
  if (opts.dryRun) {
    return { plan, summary, applied: false };
  }
  if (mode === "apply") {
    await applySyncPlan(client, plan);
    return { plan, summary, applied: true };
  }
  // mode === "queue" — header migration if needed, then route by op kind.
  for (const h of plan.headersAppended) {
    await setHeaderCell(client, plan.spreadsheetId, plan.tab, h.colIndex, h.name);
  }
  // Snapshots to advance once their Google values are reflected in the sheet.
  const snapshotWrites: Array<{ resourceName: string; fields: SnapshotFields }> = [];

  // Inserts auto-apply: a fresh row with no groups IS the pending-review
  // state in the new model. The inserted row IS the Google identity.
  let auto_inserts = 0;
  if (plan.inserts.length > 0) {
    const { applyInsertsTierA } = await import("./contacts-backfill.js");
    await applyInsertsTierA(client, plan);
    auto_inserts = plan.inserts.length;
    for (const ins of plan.inserts) {
      snapshotWrites.push({
        resourceName: ins.person.resource_name,
        fields: personToIdentity(ins.person),
      });
    }
  }
  // Route refreshes: a weak name match, or any change tiered conflict/first_run
  // (Google AND the sheet diverged from the baseline, or no baseline yet) goes
  // to the review queue. An op whose every change is `auto` (the sheet field is
  // untouched since last sync) auto-applies.
  const trivialBackfills: RefreshOp[] = [];
  const autoRefreshes: RefreshOp[] = [];
  const realRefreshes: RefreshOp[] = [];
  for (const op of plan.refreshes) {
    if (op.via === "name_weak" || !isAutoApplicable(op)) {
      realRefreshes.push(op);
    } else if (isResourceNameBackfill(op)) {
      trivialBackfills.push(op);
    } else {
      autoRefreshes.push(op);
    }
  }
  if (trivialBackfills.length > 0) {
    const { applyResourceNameBackfills } = await import("./contacts-backfill.js");
    await applyResourceNameBackfills(client, plan, trivialBackfills);
  }
  if (autoRefreshes.length > 0) {
    const { applyFormattingRefreshes } = await import("./contacts-backfill.js");
    await applyFormattingRefreshes(client, plan, autoRefreshes);
  }
  // Auto-applied rows now reflect Google → advance their snapshots.
  for (const op of [...trivialBackfills, ...autoRefreshes]) {
    snapshotWrites.push({
      resourceName: op.person.resource_name,
      fields: personToIdentity(op.person),
    });
  }
  // Seed a baseline for matched-but-unchanged contacts that lack one — their
  // sheet row already reflects Google, so the current Google identity is a
  // safe baseline.
  for (const person of plan.unchangedPersons) {
    if (!snapshots.has(person.resource_name)) {
      snapshotWrites.push({
        resourceName: person.resource_name,
        fields: personToIdentity(person),
      });
    }
  }
  await writeSnapshots(snapshotWrites);

  // A contact deleted from Google: leave the sheet row alone (it may be a
  // real CRM contact the user still wants) — just drop its stale baseline.
  if (delta.deleted.length > 0) {
    await deleteSnapshots(delta.deleted);
    console.log(`[contacts-sync] ${delta.deleted.length} contact(s) deleted in Google — snapshots dropped`);
  }

  if (plan.tombstoned.length > 0) {
    console.log(
      `[contacts-sync] suppressed ${plan.tombstoned.length} would-be insert(s) — sheet row previously deleted by user`,
    );
  }

  // Sweep: rows whose company field contains "D&DB" but tags don't include
  // DNDB → auto-add the tag so they drop out of pending review. Keeps the
  // two markers in lock-step without forcing the user to maintain both.
  const dndbRows = findCompanyDndbRows(contactsTab.rows.map((r) => r.record));
  let company_dndb_tagged = 0;
  if (dndbRows.length > 0) {
    const tagsColIdx = contactsTab.headers.indexOf("tags");
    if (tagsColIdx === -1) {
      console.log(
        `[contacts-sync] ${dndbRows.length} row(s) match D&DB-company but the sheet has no \`tags\` column — skipping`,
      );
    } else {
      const updates: CellUpdate[] = dndbRows.map((r) => ({
        range: `${plan.tab}!${colLetter(tagsColIdx)}${r.rowIndex + 2}`,
        value: r.nextTags,
      }));
      await batchUpdateCells(client, plan.spreadsheetId, updates);
      company_dndb_tagged = dndbRows.length;
      console.log(
        `[contacts-sync] auto-tagged ${dndbRows.length} row(s) DNDB (company contained "D&DB")`,
      );
    }
  }

  // Only field-diff refreshes + ambiguous go to the review queue. Drop the
  // inserts since we just applied them above.
  const planForQueue: SyncPlan = { ...plan, refreshes: realRefreshes, inserts: [] };
  const { enqueueSyncPlan } = await import("./contacts-review.js");
  const queued = await enqueueSyncPlan(planForQueue);
  // Persist the sync token only now — after the whole plan applied/enqueued
  // without throwing. On any earlier failure the old token is kept, so the
  // next run safely re-fetches the same delta (inserts dedupe by
  // resource_name, enqueue upserts).
  if (delta.nextSyncToken) {
    await setMeta(SYNC_TOKEN_KEY, delta.nextSyncToken);
  }
  return {
    plan,
    summary,
    applied: false,
    queued: {
      ...queued,
      queued_inserts: 0,
      auto_inserts,
      resource_name_backfills: trivialBackfills.length,
      formatting_refreshes: autoRefreshes.length,
      company_dndb_tagged,
    },
  };
}
