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
  "legacy_notes",
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

/**
 * Old columns we drop, but whose non-empty values we preserve into the new
 * `legacy_notes` column. Anything non-empty here gets a "key: value" line in
 * legacy_notes for that row.
 */
export const PRESERVE_TO_LEGACY_NOTES = new Set<string>([
  // social handles
  "facebook",
  "twitter",
  "instagram",
  "telegram",
  "tiktok",
  "youtube",
  // free-form
  "education",
  // Dex auto-enrichment
  "linkedin_companies",
  "linkedin_education",
  "web_search_summary",
  "business_card_url",
  // interaction text snippets
  "gmail_last_interaction_subject",
  "gcal_last_interaction_title",
  "phone_call_interaction_snippet",
  // interaction links
  "linkedin_message_link",
  "imessage_message_link",
  "whatsapp_message_link",
  "instagram_message_link",
  // last-contact timestamps
  "gmail_last_interaction_at",
  "gcal_last_interaction_at",
  "phone_call_last_interaction_at",
  "linkedin_last_message_at",
  "imessage_last_message_at",
  "whatsapp_last_message_at",
  "instagram_last_message_at",
]);

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
 * Non-empty values in PRESERVE_TO_LEGACY_NOTES columns are concatenated into the
 * new `legacy_notes` column ("oldcol: value\n…").
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
  const legacyColIndex = NEW_COLUMNS.indexOf("legacy_notes");

  // Precompute (header, oldIndex) pairs for preservation columns present in oldHeaders.
  const preservePairs: { header: string; oldIdx: number }[] = [];
  oldHeaders.forEach((h, idx) => {
    if (PRESERVE_TO_LEGACY_NOTES.has(h)) preservePairs.push({ header: h, oldIdx: idx });
  });

  return oldRows.map((row) => {
    const newRow = newColIndices.map((idx) => (idx === -1 ? "" : row[idx] ?? ""));
    if (legacyColIndex !== -1 && preservePairs.length > 0) {
      const lines: string[] = [];
      for (const { header, oldIdx } of preservePairs) {
        const v = row[oldIdx];
        if (v !== undefined && v !== "") lines.push(`${header}: ${v}`);
      }
      const existing = newRow[legacyColIndex];
      newRow[legacyColIndex] = existing
        ? lines.length > 0
          ? `${existing}\n${lines.join("\n")}`
          : existing
        : lines.join("\n");
    }
    return newRow;
  });
}
