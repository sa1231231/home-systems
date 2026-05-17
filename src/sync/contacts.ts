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
 * Identity columns sync refreshes from Google. Stripped down post-2026-05-12
 * to just the fields the dex_contacts CRM actually keeps. Enrichment columns
 * (groups, tags) are never written by sync — they're the user's domain.
 */
const IDENTITY_COLUMNS = [
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
] as const;

type IdentityCol = (typeof IDENTITY_COLUMNS)[number];

export type FieldChange = { col: string; from: string; to: string };

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
  // Auto-add the google_resource_name column when missing. It's the stable
  // Google ID for each contact — the only reliable dedupe key. The column
  // can be hidden in the Sheets UI if it's visually noisy.
  let resourceNameColIndex = headers.indexOf(RESOURCE_NAME_COL);
  let needsHeaderUpdate = false;
  if (resourceNameColIndex === -1) {
    resourceNameColIndex = headers.length;
    headers.push(RESOURCE_NAME_COL);
    needsHeaderUpdate = true;
  }

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
  /** Re-proposals blocked because the user previously rejected the same change. */
  blocked_by_prior_reject: number;
  /** Trivial refreshes that auto-applied (binding resource_name on already-matched rows). */
  resource_name_backfills: number;
  /** Refreshes where every change was formatting-only (phone/whitespace/etc.) — auto-applied. */
  formatting_refreshes: number;
  /** New rows auto-inserted into dex_contacts (Tier-A, no groups assigned). */
  auto_inserts: number;
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

/**
 * True iff a single FieldChange is "formatting-only" — same information,
 * different representation. Safe to auto-apply.
 *
 * - `google_resource_name`: binding Google's stable ID (only set when empty).
 * - `updated_at`: mechanical sync timestamp.
 * - `phone`, `phones`: same digits (after stripping non-digits + leading 1).
 * - `description`: same content after collapsing all whitespace (catches Dex
 *   import flattening newlines, e.g. "Vocal teacher24221 cascades dr" vs
 *   "Vocal teacher\n\n24221 cascades dr").
 * - `address`: same content after collapsing whitespace AND comma separators
 *   (catches "Los Angeles, CA,US" vs "Los Angeles, CA\nUS" — Google uses
 *   newlines between lines; Dex import joined them with commas).
 */
function isFormattingOnlyChange(change: FieldChange): boolean {
  if (change.col === RESOURCE_NAME_COL) return change.from === "";
  if (change.col === "updated_at") return true;
  if (change.col === "phone" || change.col === "phones") {
    return normalizePhoneCsv(change.from) === normalizePhoneCsv(change.to);
  }
  if (change.col === "email" || change.col === "emails") {
    return normalizeEmailCsv(change.from) === normalizeEmailCsv(change.to);
  }
  if (change.col === "description") {
    return stripWhitespace(change.from) === stripWhitespace(change.to);
  }
  if (change.col === "address") {
    return normalizeAddress(change.from) === normalizeAddress(change.to);
  }
  return false;
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Collapse runs of whitespace + commas down to a single space — address
 *  formatting from Google (newline-separated lines) vs Dex (comma-joined)
 *  should compare equal. */
function normalizeAddress(s: string): string {
  return s.replace(/[\s,]+/g, " ").trim().toLowerCase();
}

function normalizePhoneCsv(s: string): string {
  const set = new Set<string>();
  for (const piece of s.split(/[,;]/)) {
    const digits = piece.replace(/\D/g, "");
    const trimmed = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort().join(",");
}

/** Normalize an email or CSV-of-emails: lowercase, trim, split on
 *  comma/semicolon, dedupe, sort. Treats case + spacing + duplicate entries
 *  as formatting only. */
function normalizeEmailCsv(s: string): string {
  const set = new Set<string>();
  for (const piece of s.split(/[,;]/)) {
    const e = piece.trim().toLowerCase();
    if (e) set.add(e);
  }
  return [...set].sort().join(",");
}

/**
 * A refresh op where EVERY change is formatting-only. Whole op auto-applies
 * as a Tier-A benign write — single changelog entry per row.
 */
function isFormattingOnlyRefresh(op: RefreshOp): boolean {
  return op.updates.length > 0 && op.updates.every(isFormattingOnlyChange);
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
  // mode === "queue" — header migration if needed, then route by op kind.
  if (plan.needsHeaderUpdate) {
    await setHeaderCell(
      client,
      plan.spreadsheetId,
      plan.tab,
      plan.resourceNameColIndex,
      RESOURCE_NAME_COL,
    );
  }
  // Inserts auto-apply: a fresh row with no groups IS the pending-review
  // state in the new model.
  let auto_inserts = 0;
  if (plan.inserts.length > 0) {
    const { applyInsertsTierA } = await import("./contacts-backfill.js");
    await applyInsertsTierA(client, plan);
    auto_inserts = plan.inserts.length;
  }
  // Backfills auto-apply (binding google_resource_name on already-matched rows).
  // Formatting-only refreshes (phone reformat, description whitespace, etc.)
  // also auto-apply — same information, different representation.
  const trivialBackfills: RefreshOp[] = [];
  const formattingRefreshes: RefreshOp[] = [];
  const realRefreshes: RefreshOp[] = [];
  for (const op of plan.refreshes) {
    // A weak name match must never auto-apply — auto-binding its
    // resource_name would silently merge a possible namesake. Always queue.
    if (op.via === "name_weak") realRefreshes.push(op);
    else if (isResourceNameBackfill(op)) trivialBackfills.push(op);
    else if (isFormattingOnlyRefresh(op)) formattingRefreshes.push(op);
    else realRefreshes.push(op);
  }
  if (trivialBackfills.length > 0) {
    const { applyResourceNameBackfills } = await import("./contacts-backfill.js");
    await applyResourceNameBackfills(client, plan, trivialBackfills);
  }
  if (formattingRefreshes.length > 0) {
    const { applyFormattingRefreshes } = await import("./contacts-backfill.js");
    await applyFormattingRefreshes(client, plan, formattingRefreshes);
  }
  // Only field-diff refreshes + ambiguous go to the review queue. Drop the
  // inserts since we just applied them above.
  const planForQueue: SyncPlan = { ...plan, refreshes: realRefreshes, inserts: [] };
  const { enqueueSyncPlan } = await import("./contacts-review.js");
  const queued = await enqueueSyncPlan(planForQueue);
  return {
    plan,
    summary,
    applied: false,
    queued: {
      ...queued,
      queued_inserts: 0,
      auto_inserts,
      resource_name_backfills: trivialBackfills.length,
      formatting_refreshes: formattingRefreshes.length,
    },
  };
}
