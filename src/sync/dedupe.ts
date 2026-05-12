/**
 * Detect and merge duplicate Sheet rows. Two rows are duplicates if they
 * share any email or phone (normalized). Pure detection logic + a typed
 * plan; the application step lives separately to keep this testable.
 */
import type { SheetRow } from "./match.js";
import { normalizeEmail, normalizePhone, splitCsv } from "./normalize.js";

export type Cluster = {
  rowIndices: number[]; // always sorted ascending
  sharedEmails: string[];
  sharedPhones: string[];
};

export type MergeOp = {
  canonicalRowIndex: number;
  /** non-canonical row indices (will be deleted) */
  duplicateRowIndices: number[];
  /** updates to apply to the canonical row: column → new value (only for empty cells filled in from duplicates) */
  fills: Record<string, string>;
  sharedEmails: string[];
  sharedPhones: string[];
};

export type DedupePlan = {
  clusters: Cluster[];
  merges: MergeOp[];
  /** total non-canonical rows scheduled for deletion */
  rowsToDelete: number[];
};

function rowEmails(record: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const e of [record.email, ...splitCsv(record.emails)]) {
    const n = normalizeEmail(e);
    if (n) out.add(n);
  }
  return [...out];
}

function rowPhones(record: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const p of [record.phone, ...splitCsv(record.phones)]) {
    const n = normalizePhone(p);
    if (n) out.add(n);
  }
  return [...out];
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function findClusters(rows: SheetRow[]): Cluster[] {
  const byEmail = new Map<string, number[]>();
  const byPhone = new Map<string, number[]>();
  for (const { rowIndex, record } of rows) {
    for (const e of rowEmails(record)) {
      const arr = byEmail.get(e) ?? [];
      arr.push(rowIndex);
      byEmail.set(e, arr);
    }
    for (const p of rowPhones(record)) {
      const arr = byPhone.get(p) ?? [];
      arr.push(rowIndex);
      byPhone.set(p, arr);
    }
  }

  const uf = new UnionFind();
  for (const arr of byEmail.values()) {
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }
  for (const arr of byPhone.values()) {
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }

  const components = new Map<number, number[]>();
  for (const { rowIndex } of rows) {
    const visitedKey = byEmail.has(rowIndex.toString()) || byPhone.has(rowIndex.toString());
    void visitedKey;
  }
  // Walk only rows that participate in some email/phone group (singletons aren't unioned, so they'd be their own root).
  const participants = new Set<number>();
  for (const arr of byEmail.values()) if (arr.length > 1) for (const r of arr) participants.add(r);
  for (const arr of byPhone.values()) if (arr.length > 1) for (const r of arr) participants.add(r);

  for (const r of participants) {
    const root = uf.find(r);
    const list = components.get(root) ?? [];
    list.push(r);
    components.set(root, list);
  }

  const recordByIndex = new Map(rows.map((r) => [r.rowIndex, r.record]));

  const clusters: Cluster[] = [];
  for (const list of components.values()) {
    if (list.length < 2) continue;
    const sortedRows = [...new Set(list)].sort((a, b) => a - b);
    const allEmails = new Set<string>();
    const allPhones = new Set<string>();
    for (const r of sortedRows) {
      const rec = recordByIndex.get(r);
      if (!rec) continue;
      for (const e of rowEmails(rec)) allEmails.add(e);
      for (const p of rowPhones(rec)) allPhones.add(p);
    }
    clusters.push({
      rowIndices: sortedRows,
      sharedEmails: [...allEmails].sort(),
      sharedPhones: [...allPhones].sort(),
    });
  }
  clusters.sort((a, b) => a.rowIndices[0] - b.rowIndices[0]);
  return clusters;
}

function nonEmptyFieldCount(record: Record<string, string>): number {
  let n = 0;
  for (const v of Object.values(record)) if (v !== "" && v !== undefined && v !== null) n++;
  return n;
}

export function pickCanonical(rows: SheetRow[], cluster: Cluster): number {
  const candidates = cluster.rowIndices
    .map((idx) => rows.find((r) => r.rowIndex === idx))
    .filter((r): r is SheetRow => r !== undefined);
  // 1. Prefer rows with google_resource_name bound.
  const bound = candidates.filter((r) => (r.record.google_resource_name ?? "") !== "");
  const pool = bound.length > 0 ? bound : candidates;
  // 2. Then prefer the row with the most non-empty fields.
  pool.sort((a, b) => {
    const diff = nonEmptyFieldCount(b.record) - nonEmptyFieldCount(a.record);
    if (diff !== 0) return diff;
    return a.rowIndex - b.rowIndex; // tiebreak: lowest row index
  });
  return pool[0].rowIndex;
}

const LEGACY_NOTES = "legacy_notes";

/**
 * Columns whose values may be merged from duplicate rows into the canonical
 * row. Identity columns (name, email, phone, birthday, job_title, etc.) are
 * intentionally absent — Google Contacts is the source of truth for those,
 * and duplicate rows often have misfiled data from old Dex exports.
 *
 * Each entry maps to a merge strategy.
 */
type MergeStrategy =
  | { kind: "concat_unique"; sep: string }
  | { kind: "union_csv" }
  | { kind: "first_non_empty" }
  | { kind: "max_string" }
  | { kind: "max_date_iso" };

const MERGEABLE_COLUMNS: Record<string, MergeStrategy> = {
  legacy_notes: { kind: "concat_unique", sep: "\n---\n" },
  groups: { kind: "union_csv" },
  tags: { kind: "union_csv" },
  last_seen_at: { kind: "max_date_iso" },
};

function unionCsv(values: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(piece)) {
        seen.add(piece);
        out.push(piece);
      }
    }
  }
  return out.join(", ");
}

function applyStrategy(strategy: MergeStrategy, canonValue: string, dupValues: string[]): string {
  switch (strategy.kind) {
    case "concat_unique": {
      const pieces: string[] = [];
      if (canonValue) pieces.push(canonValue);
      for (const v of dupValues) {
        if (v && !pieces.includes(v)) pieces.push(v);
      }
      return pieces.join(strategy.sep);
    }
    case "union_csv":
      return unionCsv([canonValue, ...dupValues]);
    case "first_non_empty": {
      if (canonValue !== "") return canonValue;
      for (const v of dupValues) if (v !== "") return v;
      return "";
    }
    case "max_string": {
      let best = canonValue;
      for (const v of dupValues) if (v > best) best = v;
      return best;
    }
    case "max_date_iso": {
      let best = canonValue;
      for (const v of dupValues) {
        if (!v) continue;
        if (!best || v > best) best = v;
      }
      return best;
    }
  }
}

export function buildMerge(rows: SheetRow[], cluster: Cluster): MergeOp {
  const canonicalIdx = pickCanonical(rows, cluster);
  const canonicalRow = rows.find((r) => r.rowIndex === canonicalIdx)!;
  const dupIndices = cluster.rowIndices.filter((i) => i !== canonicalIdx);
  const dupRows = dupIndices
    .map((idx) => rows.find((r) => r.rowIndex === idx))
    .filter((r): r is SheetRow => r !== undefined);

  const fills: Record<string, string> = {};

  for (const [col, strategy] of Object.entries(MERGEABLE_COLUMNS)) {
    const canonValue = canonicalRow.record[col] ?? "";
    const dupValues = dupRows.map((r) => r.record[col] ?? "");
    const merged = applyStrategy(strategy, canonValue, dupValues);
    if (merged !== canonValue) fills[col] = merged;
  }

  // Special case: if canonical lacks google_resource_name but a duplicate has
  // one, adopt it. (Shouldn't happen since pickCanonical prefers bound rows,
  // but defensive.)
  const canonResource = canonicalRow.record.google_resource_name ?? "";
  if (canonResource === "") {
    for (const dup of dupRows) {
      const r = dup.record.google_resource_name ?? "";
      if (r !== "") {
        fills.google_resource_name = r;
        break;
      }
    }
  }

  return {
    canonicalRowIndex: canonicalIdx,
    duplicateRowIndices: dupIndices.sort((a, b) => a - b),
    fills,
    sharedEmails: cluster.sharedEmails,
    sharedPhones: cluster.sharedPhones,
  };
}

export function planDedupe(rows: SheetRow[]): DedupePlan {
  const clusters = findClusters(rows);
  const merges = clusters.map((c) => buildMerge(rows, c));
  const rowsToDelete = merges.flatMap((m) => m.duplicateRowIndices).sort((a, b) => a - b);
  return { clusters, merges, rowsToDelete };
}

export type DedupeSummary = {
  clusters: number;
  rows_merged_into_canonical: number;
  rows_deleted: number;
  cells_filled: number;
  largest_cluster: number;
};

export function summarizeDedupe(plan: DedupePlan): DedupeSummary {
  return {
    clusters: plan.clusters.length,
    rows_merged_into_canonical: plan.merges.length,
    rows_deleted: plan.rowsToDelete.length,
    cells_filled: plan.merges.reduce((n, m) => n + Object.keys(m.fills).length, 0),
    largest_cluster: plan.clusters.reduce((n, c) => Math.max(n, c.rowIndices.length), 0),
  };
}
