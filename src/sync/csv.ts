/**
 * CSV cell helpers. Sheet stores groups/tags as comma-separated strings;
 * these keep insertion order, dedupe case-insensitively, and treat the
 * canonical display form as the first occurrence we saw.
 */

export function parseCsv(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function formatCsv(items: string[]): string {
  return items.join(", ");
}

export function addToCsv(current: string, additions: string[]): { value: string; changed: boolean } {
  const existing = parseCsv(current);
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const out = [...existing];
  let changed = false;
  for (const item of additions) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!seen.has(trimmed.toLowerCase())) {
      out.push(trimmed);
      seen.add(trimmed.toLowerCase());
      changed = true;
    }
  }
  return { value: formatCsv(out), changed };
}

export function removeFromCsv(current: string, removals: string[]): { value: string; changed: boolean } {
  const existing = parseCsv(current);
  const removeSet = new Set(removals.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (removeSet.size === 0) return { value: current, changed: false };
  const out = existing.filter((s) => !removeSet.has(s.toLowerCase()));
  return { value: formatCsv(out), changed: out.length !== existing.length };
}
