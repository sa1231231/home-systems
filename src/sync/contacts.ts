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
 * Identity columns we refresh from Google. Order matches the listing in
 * personToIdentity. Enrichment columns (groups, tags, starred, archived,
 * location, etc.) are never written by sync.
 */
const IDENTITY_COLUMNS = [
  "full_name",
  "first_name",
  "last_name",
  "description",
  "birthday",
  "birthday_year",
  "job_title",
  "company",
  "image_url",
  "linkedin",
  "website",
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
    linkedin: p.linkedin_url ?? "",
    website: p.website ?? "",
    dex_email: p.emails[0] ?? "",
    dex_emails: p.emails.join(", "),
    dex_phone: p.phones[0] ?? "",
    dex_phones: p.phones.join(", "),
    dex_address: p.address ?? "",
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
  let needsHeaderUpdate = false;
  let resourceNameColIndex = headers.indexOf(RESOURCE_NAME_COL);
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

export async function runSync(
  client: OAuth2Client,
  spreadsheetId: string,
  opts: { dryRun: boolean; tab?: string; nowIso?: string } = { dryRun: true },
): Promise<{ plan: SyncPlan; summary: SyncSummary; applied: boolean }> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const [people, contactsTab] = await Promise.all([
    listAllConnections(client),
    readContactsTab(client, spreadsheetId, { tab: opts.tab }),
  ]);
  const plan = planSync(spreadsheetId, contactsTab, people, nowIso);
  const summary = summarize(plan);
  if (opts.dryRun) {
    return { plan, summary, applied: false };
  }
  await applySyncPlan(client, plan);
  return { plan, summary, applied: true };
}
