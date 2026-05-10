/**
 * Pure column-cleanup transform. Computes the new sheet structure from the
 * old one without touching any external systems. Used by the one-time
 * cleanup script (scripts/cleanup-columns.ts).
 */

export const NEW_COLUMNS = [
  "google_resource_name",
  "full_name",
  "first_name",
  "last_name",
  "email",
  "emails",
  "phone",
  "phones",
  "address",
  "description",
  "job_title",
  "company",
  "birthday",
  "birthday_year",
  "linkedin_url",
  "website",
  "image_url",
  "groups",
  "tags",
  "starred",
  "is_archived",
  "last_seen_at",
  "location",
  "created_at",
  "updated_at",
] as const;

/** Old-name → new-name. Columns not listed here keep their old name (and are kept iff in NEW_COLUMNS). */
export const RENAMES: Record<string, string> = {
  dex_email: "email",
  dex_emails: "emails",
  dex_phone: "phone",
  dex_phones: "phones",
  dex_address: "address",
  dex_groups: "groups",
  dex_tags: "tags",
  linkedin: "linkedin_url",
};

export type CleanupPlan = {
  oldHeaders: string[];
  newHeaders: string[];
  /** Columns present in oldHeaders that won't appear in the new sheet. */
  dropped: string[];
  /** Columns being renamed (old → new). */
  renamed: { from: string; to: string }[];
  /** Columns kept as-is (same name in old + new). */
  kept: string[];
  /** True if the sheet already has the new structure (no work needed). */
  alreadyClean: boolean;
};

export function planCleanup(oldHeaders: string[]): CleanupPlan {
  const newHeaders = [...NEW_COLUMNS];
  const newSet = new Set<string>(newHeaders);

  const renamed: { from: string; to: string }[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const oldName of oldHeaders) {
    const renameTo = RENAMES[oldName];
    if (renameTo && newSet.has(renameTo)) {
      renamed.push({ from: oldName, to: renameTo });
    } else if (newSet.has(oldName)) {
      kept.push(oldName);
    } else {
      dropped.push(oldName);
    }
  }

  const alreadyClean = oldHeaders.length === newHeaders.length && oldHeaders.every((h, i) => h === newHeaders[i]);

  return { oldHeaders, newHeaders, dropped, renamed, kept, alreadyClean };
}

/**
 * Transform old rows (aligned with oldHeaders) into new rows (aligned with NEW_COLUMNS).
 * Each new column reads from the corresponding old column (post-rename) when present;
 * missing columns (e.g. google_resource_name on rows that pre-date sync) emit "".
 */
export function transformRows(oldHeaders: string[], oldRows: string[][]): string[][] {
  const oldIndexFor = (target: string): number => {
    const direct = oldHeaders.indexOf(target);
    if (direct !== -1) return direct;
    for (const [from, to] of Object.entries(RENAMES)) {
      if (to === target) {
        const renameSrc = oldHeaders.indexOf(from);
        if (renameSrc !== -1) return renameSrc;
      }
    }
    return -1;
  };
  const newColIndices = NEW_COLUMNS.map((name) => oldIndexFor(name));
  return oldRows.map((row) => newColIndices.map((idx) => (idx === -1 ? "" : row[idx] ?? "")));
}
