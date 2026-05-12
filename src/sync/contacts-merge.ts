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
  first_name: "longest",
  last_name: "longest",
  full_name: "longest",
  address: "longest",
  job_title: "longest",
  company: "longest",
  birthday: "longest",
  linkedin_url: "longest",
  website: "longest",
  location: "longest",
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
 */
export function buildMergePlan(rows: SheetRowAt[], headers: string[]): MergePlan {
  if (rows.length < 2) {
    throw new Error(`buildMergePlan needs ≥ 2 rows, got ${rows.length}`);
  }
  const sorted = [...rows].sort((a, b) => a.rowIndex - b.rowIndex);
  const keeper = sorted[0];
  const others = sorted.slice(1);

  const updates: MergeUpdate[] = [];
  for (const col of headers) {
    const strategy: MergeStrategy = MERGE_STRATEGIES[col] ?? "longest";
    const allValues = sorted.map((r) => r.record[col] ?? "");
    const merged = applyMergeStrategy(strategy, allValues);
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
