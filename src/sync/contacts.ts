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
import { loadSnapshots, writeSnapshots, type SnapshotFields } from "./contact-snapshots.js";

const RESOURCE_NAME_COL = "google_resource_name";

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
] as const;

type IdentityCol = (typeof IDENTITY_COLUMNS)[number];

/**
 * - `auto`: Google changed, the sheet field is untouched since last sync —
 *   safe to apply without review.
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
  /** true when the Sheet was missing google_resource_name and we will append it */
  needsHeaderUpdate: boolean;
  resourceNameColIndex: number;
  inserts: InsertOp[];
  refreshes: RefreshOp[];
  ambiguous: AmbiguousOp[];
  unchanged: number;
  /** Matched contacts with no proposed changes — used to seed missing snapshots. */
  unchangedPersons: GooglePerson[];
};

export type SyncSummary = {
  inserted: number;
  refreshed: number;
  unchanged: number;
  ambiguous: number;
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
  };
}

/**
 * Compute changes for a matched row via a 3-way compare — Google-now vs
 * Sheet-now vs the last-synced snapshot (`base`). Empty Google values never
 * overwrite the Sheet. A field is only emitted as a change when Google
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
    // Empty Google value never overwrites the sheet; identical → nothing to do.
    if (googleNow === "" || googleNow === sheetNow) continue;
    const base = snapshot?.[col];
    let tier: ChangeTier;
    if (base === undefined) {
      tier = "first_run";
    } else if (googleNow === base) {
      // Google hasn't moved since last sync — leave the sheet (incl. any
      // hand edit) untouched.
      continue;
    } else if (sheetNow === base) {
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
  const unchangedPersons: GooglePerson[] = [];

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
    inserts,
    refreshes,
    ambiguous,
    unchanged: unchangedPersons.length,
    unchangedPersons,
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
  const [people, contactsTab] = await Promise.all([
    listAllConnections(client),
    readContactsTab(client, spreadsheetId, { tab: opts.tab }),
  ]);
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
  if (plan.needsHeaderUpdate) {
    await setHeaderCell(
      client,
      plan.spreadsheetId,
      plan.tab,
      plan.resourceNameColIndex,
      RESOURCE_NAME_COL,
    );
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
      formatting_refreshes: autoRefreshes.length,
    },
  };
}
