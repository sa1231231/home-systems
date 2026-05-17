/**
 * Merge logic for "user-confirmed same-person" duplicate sheet rows.
 *
 * The dedupe module (sync/dedupe.ts) is intentionally conservative — it
 * never merges identity columns (name / emails / phones) because that
 * runs on a cron without user judgment and a name conflict is a red
 * flag that signals different people.
 *
 * This module is the opposite: it runs only when a human has clicked
 * "Merge" on an ambiguous review row, meaning they've already looked
 * at the rows side-by-side and confirmed they're the same person.
 * Every column merges; data is preserved by union/longest/concat
 * rules so nothing is silently dropped.
 */

export type SheetRowRecord = Record<string, string>;

export type SheetRowAt = { rowIndex: number; record: SheetRowRecord };

export type MergeStrategy = "union_csv" | "longest" | "concat_unique";

/**
 * Column merge strategies. Anything not listed falls back to "longest".
 * - union_csv: split on comma, trim, dedupe (case-insensitive), rejoin "a, b, c"
 * - longest: keep the longest trimmed value across all rows
 * - concat_unique: join distinct non-empty values with "\n---\n"
 */
export const MERGE_STRATEGIES: Record<string, MergeStrategy> = {
  emails: "union_csv",
  email: "union_csv",
  phones: "union_csv",
  phone: "union_csv",
  groups: "union_csv",
  tags: "union_csv",
  legacy_notes: "concat_unique",
  description: "longest",
  full_name: "longest",
  address: "longest",
  job_title: "longest",
  company: "longest",
  website: "longest",
};

function unionCsv(values: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      const key = piece.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(piece);
      }
    }
  }
  return out.join(", ");
}

function longest(values: string[]): string {
  let best = "";
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed.length > best.length) best = trimmed;
  }
  return best;
}

/**
 * Tokens that, when they appear after an otherwise-shorter version of a
 * name, signal the longer string is name + company-descriptor stuffed
 * together. Conservative list — only tokens that essentially never appear
 * as part of a person's actual surname.
 */
const COMPANY_SUFFIX_TOKENS = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "company",
  "co",
  "group",
  "partners",
  "holdings",
  "associates",
  "management",
  "mgmt",
  "solutions",
  "services",
  "consulting",
  "ventures",
  "capital",
  "investments",
  "center",
  "centre",
  "clinic",
  "hospital",
  "agency",
  "bureau",
  "studio",
  "studios",
  "productions",
  "media",
  "law",
  "legal",
  "tax",
  "accounting",
  "realty",
  "real estate",
  "technologies",
  "tech",
  "systems",
  "labs",
  "industries",
  "enterprises",
  "international",
  "global",
  "trust",
  "foundation",
  "fund",
  "school",
  "academy",
  "church",
  "ministries",
]);

/**
 * True iff `longer` looks like "<shorter> + a company-descriptor tail".
 * E.g. isCompanySuffix("Aguilera Law Center", "Aguilera") → true.
 * Used to keep the clean surname when one row has it bare and another has
 * the stuffed form.
 */
export function isCompanySuffix(longer: string, shorter: string): boolean {
  const a = longer.trim().toLowerCase();
  const b = shorter.trim().toLowerCase();
  if (!a || !b) return false;
  if (a.length <= b.length) return false;
  if (!a.startsWith(b + " ") && !a.startsWith(b + "-")) return false;
  const tail = a.slice(b.length).replace(/^[\s-]+/, "");
  if (!tail) return false;
  const tokens = tail.split(/\s+/);
  return tokens.some((t) => COMPANY_SUFFIX_TOKENS.has(t));
}

/**
 * Like `longest()` but recognizes "<clean name> + <company suffix>"
 * pairings and keeps the clean form. Fixes:
 *   - "Aguilera" vs "Aguilera Law Center" → keep "Aguilera"
 *   - "Spann" vs "Spann Stoneburgh Management" → keep "Spann"
 * Without breaking legit longer names:
 *   - "Wymore" vs "Wymore-Kirkland" → keep "Wymore-Kirkland"
 *   - "Sam" vs "Samuel" → keep "Samuel"
 */
export function pickBetterName(values: string[]): string {
  const trimmed = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (trimmed.length === 0) return "";
  let best = trimmed[0];
  for (const c of trimmed.slice(1)) {
    if (isCompanySuffix(c, best)) continue; // c is best + junk → keep best
    if (isCompanySuffix(best, c)) {
      best = c; // best is c + junk → switch to c
      continue;
    }
    if (c.length > best.length) best = c;
  }
  return best;
}

function concatUnique(values: string[], sep = "\n---\n"): string {
  const pieces: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      pieces.push(trimmed);
    }
  }
  return pieces.join(sep);
}

export function applyMergeStrategy(strategy: MergeStrategy, values: string[]): string {
  switch (strategy) {
    case "union_csv":
      return unionCsv(values);
    case "longest":
      return longest(values);
    case "concat_unique":
      return concatUnique(values);
  }
}

/**
 * Merge full_name across duplicate rows. Uses pickBetterName so we keep the
 * clean form when one row has "Aguilera" and another has
 * "Aguilera Law Center" — the bare surname wins.
 */
export function mergeFullName(rows: SheetRowAt[]): string {
  return pickBetterName(rows.map((r) => r.record.full_name ?? ""));
}

export type MergeUpdate = { col: string; from: string; to: string };

export type MergePlan = {
  /** The row that survives — receives the merged values. Lowest rowIndex wins. */
  keeperRowIndex: number;
  /** Rows that get deleted from the sheet after the keeper is updated. */
  deleteRowIndices: number[];
  /** Cell-level diffs to apply to the keeper. */
  updates: MergeUpdate[];
  /** Snapshot of every input row for the changelog. */
  beforeRows: Array<{ rowIndex: number; record: SheetRowRecord }>;
};

/**
 * Pure planner: given the matching rows (in any order) and the sheet's
 * current headers, produce the keeper + updates + delete list. Does not
 * touch the sheet — the caller wraps in changelog + applies.
 *
 * By default the keeper is the lowest row index. Pass `opts.keeperRowIndex`
 * to force a specific row to survive (used by duplicate consolidation, where
 * the keeper must be the row carrying the google_resource_name).
 */
export function buildMergePlan(
  rows: SheetRowAt[],
  headers: string[],
  opts: { keeperRowIndex?: number } = {},
): MergePlan {
  if (rows.length < 2) {
    throw new Error(`buildMergePlan needs ≥ 2 rows, got ${rows.length}`);
  }
  const sorted = [...rows].sort((a, b) => a.rowIndex - b.rowIndex);
  let keeper: SheetRowAt;
  let others: SheetRowAt[];
  if (opts.keeperRowIndex !== undefined) {
    const found = sorted.find((r) => r.rowIndex === opts.keeperRowIndex);
    if (!found) {
      throw new Error(`buildMergePlan: keeperRowIndex ${opts.keeperRowIndex} not among rows`);
    }
    keeper = found;
    others = sorted.filter((r) => r.rowIndex !== opts.keeperRowIndex);
  } else {
    keeper = sorted[0];
    others = sorted.slice(1);
  }

  const updates: MergeUpdate[] = [];
  for (const col of headers) {
    let merged: string;
    if (col === "full_name") {
      merged = mergeFullName(sorted);
    } else {
      const strategy: MergeStrategy = MERGE_STRATEGIES[col] ?? "longest";
      const allValues = sorted.map((r) => r.record[col] ?? "");
      merged = applyMergeStrategy(strategy, allValues);
    }
    const oldVal = (keeper.record[col] ?? "").trim();
    if (merged !== oldVal && merged !== "") {
      updates.push({ col, from: oldVal, to: merged });
    }
  }

  return {
    keeperRowIndex: keeper.rowIndex,
    deleteRowIndices: others.map((o) => o.rowIndex),
    updates,
    beforeRows: sorted.map((r) => ({ rowIndex: r.rowIndex, record: r.record })),
  };
}
