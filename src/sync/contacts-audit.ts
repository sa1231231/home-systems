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

export type AuditReport = {
  orphans: OrphanDuplicate[];
  emptyRows: EmptyRow[];
  /** Rows with a full_name but no resource_name, email, or phone — and no
   *  matching canonical row. Likely manual entries with no Google contact. */
  nameOnly: NameOnlyRow[];
};

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function get(row: SheetRow, key: string): string {
  return (row[key] ?? "").trim();
}

/** A row counts as "real" if it has any reachable handle: email, phone,
 *  LinkedIn, or website. Per user rule: LinkedIn URL alone is sufficient. */
function hasContactInfo(row: SheetRow): boolean {
  return (
    nonEmpty(row.email) ||
    nonEmpty(row.emails) ||
    nonEmpty(row.phone) ||
    nonEmpty(row.phones) ||
    nonEmpty(row.linkedin_url) ||
    nonEmpty(row.website)
  );
}

/** Compose a name key for dedupe — prefers explicit full_name when present
 *  (legacy schema), else falls back to "first last". */
function nameKey(row: SheetRow): string {
  const full = get(row, "full_name");
  if (full) return full;
  const first = get(row, "first_name");
  const last = get(row, "last_name");
  return `${first} ${last}`.trim();
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

  return { orphans, emptyRows, nameOnly };
}
