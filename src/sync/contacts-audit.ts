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

function hasContactInfo(row: SheetRow): boolean {
  return (
    nonEmpty(row.email) ||
    nonEmpty(row.emails) ||
    nonEmpty(row.phone) ||
    nonEmpty(row.phones)
  );
}

/**
 * Find rows that look like leftover duplicates from an earlier broken sync:
 *
 *   1. row has NO google_resource_name (orphan)
 *   2. row has a full_name
 *   3. there's another row with the SAME full_name that DOES have a
 *      google_resource_name (the canonical row)
 *
 * Returns one OrphanDuplicate per orphan, pointing at the canonical row.
 */
export function findAuditIssues(rows: SheetRow[]): AuditReport {
  // Index canonical rows (those that have a resource_name) by trimmed full_name.
  const canonicalByName = new Map<string, number>();
  rows.forEach((row, i) => {
    const fullName = get(row, "full_name");
    const resourceName = get(row, "google_resource_name");
    if (fullName && resourceName) {
      // first canonical row wins; keep the lowest row index
      if (!canonicalByName.has(fullName)) {
        canonicalByName.set(fullName, i);
      }
    }
  });

  const orphans: OrphanDuplicate[] = [];
  const emptyRows: EmptyRow[] = [];
  const nameOnly: NameOnlyRow[] = [];

  rows.forEach((row, i) => {
    const fullName = get(row, "full_name");
    const resourceName = get(row, "google_resource_name");
    // Skip the canonical row itself.
    if (resourceName) return;
    if (!fullName) {
      // No name and no resource_name — truly empty row, definitely orphan.
      const anyValue = Object.values(row).some(nonEmpty);
      if (!anyValue) emptyRows.push({ rowIndex: i });
      return;
    }
    const canonicalRowIndex = canonicalByName.get(fullName);
    if (canonicalRowIndex !== undefined && canonicalRowIndex !== i) {
      orphans.push({ rowIndex: i, fullName, canonicalRowIndex });
      return;
    }
    // Name set but no canonical match. If the row also has no contact info,
    // it's a manual / name-only entry; surface so the user can delete or fix.
    if (!hasContactInfo(row)) {
      nameOnly.push({ rowIndex: i, fullName });
    }
  });

  return { orphans, emptyRows, nameOnly };
}
