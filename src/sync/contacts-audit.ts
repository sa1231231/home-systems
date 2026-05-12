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

export type FragmentOrphan = {
  rowIndex: number;
  /** The single-word name in the orphan's first_name column. */
  firstName: string;
  /** Canonical row whose last_name matches firstName. */
  canonicalRowIndex: number;
  /** "First Last" of the canonical row (for display). */
  canonicalName: string;
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
  /** Rows with a single-word first_name, empty last_name, no contact info,
   *  where the first_name matches the last_name of another row that DOES
   *  have contact info. Almost certainly a stuffed-last-name leftover
   *  from an old Dex import — Sean Swarner's canonical row exists, this
   *  orphan just has "Swarner" alone with nothing else attached. */
  fragmentOrphans: FragmentOrphan[];
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

  return {
    orphans,
    emptyRows,
    nameOnly,
    emailDuplicates: findValueDuplicates(rows, emailsInRow),
    phoneDuplicates: findValueDuplicates(rows, phonesInRow),
    fragmentOrphans: findFragmentOrphans(rows),
  };
}

/**
 * Look for the "last-name-only stuffed into first_name" pattern:
 *
 *   row A: first_name="Sean", last_name="Swarner", phone="555…"   (canonical)
 *   row B: first_name="Swarner", last_name="", no contact info     (orphan)
 *
 * The orphan in B is a leftover from an old import — the dedupe loop can't
 * touch it because nothing matches by email/phone. Surface it so the user
 * can delete it.
 *
 * Match rules: orphan must have first_name be a single word (no space),
 * last_name empty, no email/phone/linkedin/website. The canonical must
 * have BOTH first_name and last_name set AND any contact info AND its
 * last_name (case-insensitive) equal to the orphan's first_name.
 */
export function findFragmentOrphans(rows: SheetRow[]): FragmentOrphan[] {
  const canonicalByLast = new Map<string, number>();
  rows.forEach((row, i) => {
    const first = get(row, "first_name");
    const last = get(row, "last_name");
    if (first && last && hasContactInfo(row)) {
      const key = last.toLowerCase();
      if (!canonicalByLast.has(key)) canonicalByLast.set(key, i);
    }
  });

  const out: FragmentOrphan[] = [];
  rows.forEach((row, i) => {
    const first = get(row, "first_name");
    const last = get(row, "last_name");
    if (!first || last) return;
    if (first.includes(" ")) return;
    if (hasContactInfo(row)) return;
    const canonicalRowIndex = canonicalByLast.get(first.toLowerCase());
    if (canonicalRowIndex === undefined || canonicalRowIndex === i) return;
    const canon = rows[canonicalRowIndex];
    out.push({
      rowIndex: i,
      firstName: first,
      canonicalRowIndex,
      canonicalName: `${(canon.first_name ?? "").trim()} ${(canon.last_name ?? "").trim()}`.trim(),
    });
  });
  return out;
}
