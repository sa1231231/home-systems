/**
 * Pure scanning helpers for the CRM contacts sheet — find rows that need
 * cleanup. No DB, no sheets API, just data-in / data-out.
 */

export type SheetRow = Record<string, string>;

export type OrphanDuplicate = {
  rowIndex: number;
  fullName: string;
  /** Row index (0-based, excluding the header) of the canonical row with the same name. */
  canonicalRowIndex: number;
};

export type EmptyRow = {
  rowIndex: number;
};

export type NameOnlyRow = {
  rowIndex: number;
  fullName: string;
};

export type DuplicateGroup = {
  /** The normalized email or phone shared by every row in the group. */
  value: string;
  /** All sheet row indices that share this value (always ≥ 2). */
  rowIndices: number[];
};

export type NoGroupRow = {
  rowIndex: number;
  fullName: string;
  primaryEmail: string;
  primaryPhone: string;
  company: string;
  /** google_resource_name on this row, if bound (empty string if not). */
  resourceName: string;
};

export type AuditReport = {
  orphans: OrphanDuplicate[];
  emptyRows: EmptyRow[];
  /** Rows with a full_name but no resource_name, email, or phone — and no
   *  matching canonical row. Likely manual entries with no Google contact. */
  nameOnly: NameOnlyRow[];
  /** Two-or-more rows that share a normalized email address. Sorted largest
   *  cluster first. */
  emailDuplicates: DuplicateGroup[];
  /** Two-or-more rows that share a normalized phone number (digits only). */
  phoneDuplicates: DuplicateGroup[];
  /** Rows where groups is empty — these are "pending review" in the new
   *  CRM model. Auto-inserted Google contacts and any manually-added row
   *  without a group land here. */
  noGroup: NoGroupRow[];
};

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function get(row: SheetRow, key: string): string {
  return (row[key] ?? "").trim();
}

/** A row counts as "real" if it has any reachable handle: email, phone,
 *  website, a LinkedIn / Instagram URL in its own column, OR a URL embedded
 *  in the description (X/Twitter profile links and similar fall here). */
function hasContactInfo(row: SheetRow): boolean {
  return (
    nonEmpty(row.email) ||
    nonEmpty(row.emails) ||
    nonEmpty(row.phone) ||
    nonEmpty(row.phones) ||
    nonEmpty(row.website) ||
    nonEmpty(row.linkedin) ||
    nonEmpty(row.instagram) ||
    descriptionHasUrl(row.description)
  );
}

const URL_OR_HANDLE_RE = /(https?:\/\/|www\.|linkedin\.com|instagram\.com|x\.com\/|twitter\.com|facebook\.com|t\.me\/|tiktok\.com|youtube\.com)/i;

/** True if the description text contains a URL or a recognizable social
 *  handle. Lets a row with "linkedin.com/in/jane" in description count as
 *  a contactable person even with no email/phone column populated. */
export function descriptionHasUrl(description: string | undefined): boolean {
  if (!description) return false;
  return URL_OR_HANDLE_RE.test(description);
}

function splitCsv(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeEmail(s: string): string {
  return s.toLowerCase().trim();
}

function normalizePhone(s: string): string {
  // Keep digits only. Drop a leading "1" (US country code) if there are 11
  // digits so "+1 555-1234" and "555-1234" collapse to the same key.
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Extracted set of normalized emails from a row (legacy + canonical cols). */
export function emailsInRow(row: SheetRow): string[] {
  const all = [...splitCsv(get(row, "email")), ...splitCsv(get(row, "emails"))];
  return all.map(normalizeEmail).filter((e) => e.length > 0 && e.includes("@"));
}

/** Extracted set of normalized phones (digit-only, leading 1 stripped). */
export function phonesInRow(row: SheetRow): string[] {
  const all = [...splitCsv(get(row, "phone")), ...splitCsv(get(row, "phones"))];
  // Require ≥ 7 digits so we don't cluster on extension numbers / fragments.
  return all.map(normalizePhone).filter((p) => p.length >= 7);
}

function findValueDuplicates(
  rows: SheetRow[],
  extract: (row: SheetRow) => string[],
): DuplicateGroup[] {
  const byValue = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const seenForThisRow = new Set<string>();
    for (const v of extract(row)) {
      if (seenForThisRow.has(v)) continue; // a row that lists the same email twice still counts as one
      seenForThisRow.add(v);
      const list = byValue.get(v);
      if (list) list.push(i);
      else byValue.set(v, [i]);
    }
  });
  const out: DuplicateGroup[] = [];
  for (const [value, indices] of byValue) {
    if (indices.length > 1) out.push({ value, rowIndices: indices });
  }
  // Sort by cluster size desc, then by value for stable output.
  out.sort((a, b) => b.rowIndices.length - a.rowIndices.length || a.value.localeCompare(b.value));
  return out;
}

function nameKey(row: SheetRow): string {
  return get(row, "full_name");
}

export type RowWithIndex = { rowIndex: number; record: SheetRow };

export type DuplicateNameGroup = {
  /** Normalized (lowercased) full_name shared by every row in the group. */
  name: string;
  /** The row that has a google_resource_name — the synced row, kept. */
  keeperRowIndex: number;
  /** Name-only duplicate rows to fold into the keeper. */
  duplicateRowIndices: number[];
};

/**
 * Duplicate-row groups safe to auto-consolidate: ≥2 rows share a normalized
 * full_name and exactly one of them has a google_resource_name. That
 * resource-name row is the keeper (the synced one); the rest are pre-existing
 * name-only rows to fold in. Groups with zero or ≥2 resource-name rows are
 * excluded — those need human judgment.
 */
export function findDuplicateNameGroups(rows: RowWithIndex[]): DuplicateNameGroup[] {
  const byName = new Map<string, RowWithIndex[]>();
  for (const r of rows) {
    const name = get(r.record, "full_name").toLowerCase();
    if (!name) continue;
    const arr = byName.get(name);
    if (arr) arr.push(r);
    else byName.set(name, [r]);
  }
  const out: DuplicateNameGroup[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const withResource = group.filter((r) => get(r.record, "google_resource_name"));
    if (withResource.length !== 1) continue;
    const keeperRowIndex = withResource[0].rowIndex;
    out.push({
      name,
      keeperRowIndex,
      duplicateRowIndices: group
        .filter((r) => r.rowIndex !== keeperRowIndex)
        .map((r) => r.rowIndex),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Categorize the sheet:
 *
 * - **orphans**: a row with NO contact info whose name matches another
 *   row that DOES have contact info. The other row wins; this row is
 *   a leftover. Works on both legacy schemas (full_name + resource_name)
 *   and the post-cleanup schema (first_name + last_name only).
 * - **emptyRows**: every cell is blank.
 * - **nameOnly**: has a name, no contact info, AND no matching
 *   canonical row. Could be a manual entry without contact data yet,
 *   could be junk — surfaced for human review, not auto-deleted.
 */
export function findAuditIssues(rows: SheetRow[]): AuditReport {
  // Index canonical rows (those that have at least one form of contact info) by name.
  const canonicalByName = new Map<string, number>();
  rows.forEach((row, i) => {
    const name = nameKey(row);
    if (name && hasContactInfo(row)) {
      if (!canonicalByName.has(name)) canonicalByName.set(name, i);
    }
  });

  const orphans: OrphanDuplicate[] = [];
  const emptyRows: EmptyRow[] = [];
  const nameOnly: NameOnlyRow[] = [];

  rows.forEach((row, i) => {
    if (hasContactInfo(row)) return; // canonical or non-orphan extra — leave alone
    const name = nameKey(row);
    if (!name) {
      const anyValue = Object.values(row).some(nonEmpty);
      if (!anyValue) emptyRows.push({ rowIndex: i });
      return;
    }
    const canonicalRowIndex = canonicalByName.get(name);
    if (canonicalRowIndex !== undefined && canonicalRowIndex !== i) {
      orphans.push({ rowIndex: i, fullName: name, canonicalRowIndex });
      return;
    }
    nameOnly.push({ rowIndex: i, fullName: name });
  });

  return {
    orphans,
    emptyRows,
    nameOnly,
    emailDuplicates: findValueDuplicates(rows, emailsInRow),
    phoneDuplicates: findValueDuplicates(rows, phonesInRow),
    noGroup: findNoGroupRows(rows),
  };
}

/**
 * Tag that marks a contact as deliberately exempt from "pending review".
 * Stands for "do not do business" — these people legitimately have no group
 * because the user doesn't plan to use them for outreach, and re-surfacing
 * them every sync is noise.
 */
const REVIEW_EXEMPT_TAG = "DNDB";

/** True iff the row's `tags` CSV contains the given tag (case-insensitive,
 *  exact token match — "DNDB-foo" doesn't count). */
export function hasTag(row: SheetRow, tag: string): boolean {
  const raw = (row.tags ?? "").trim();
  if (!raw) return false;
  const want = tag.toLowerCase();
  return raw
    .split(/[,;]/)
    .some((t) => t.trim().toLowerCase() === want);
}

/**
 * Rows that have a name + Google ID (or contact info) but no value in
 * `groups`. These are the new "pending review" — the user needs to
 * assign a group from groups before the row counts as filed away.
 *
 * Excludes empty rows and rows with no name (those land in other audit
 * categories), and rows tagged `DNDB` (do not do business — intentionally
 * group-less, not awaiting review).
 */
export function findNoGroupRows(rows: SheetRow[]): NoGroupRow[] {
  const out: NoGroupRow[] = [];
  rows.forEach((row, i) => {
    const name = get(row, "full_name");
    if (!name) return;
    const group = get(row, "groups");
    if (group) return;
    if (hasTag(row, REVIEW_EXEMPT_TAG)) return;
    out.push({
      rowIndex: i,
      fullName: name,
      primaryEmail: (row.email || row.emails || "").trim(),
      primaryPhone: (row.phone || row.phones || "").trim(),
      company: (row.company || "").trim(),
      resourceName: (row.google_resource_name || "").trim(),
    });
  });
  return out;
}
