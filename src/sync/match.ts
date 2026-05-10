import type { GooglePerson } from "../integrations/google/people.js";
import { normalizeEmail, normalizePhone, splitCsv } from "./normalize.js";

export type SheetRow = { rowIndex: number; record: Record<string, string> };

export type SheetIndex = {
  byResourceName: Map<string, number>;
  byEmail: Map<string, number[]>;
  byPhone: Map<string, number[]>;
};

export type MatchResult =
  | { kind: "resource_name"; rowIndex: number }
  | { kind: "email"; rowIndex: number }
  | { kind: "phone"; rowIndex: number }
  | { kind: "ambiguous"; matches: number[]; via: "email" | "phone" }
  | { kind: "none" };

function rowEmails(record: Record<string, string>): string[] {
  const all = [
    record.email,
    ...splitCsv(record.emails),
    record.dex_email, // legacy column name (pre-cleanup)
    ...splitCsv(record.dex_emails),
  ];
  const out = new Set<string>();
  for (const e of all) {
    const n = normalizeEmail(e);
    if (n) out.add(n);
  }
  return [...out];
}

function rowPhones(record: Record<string, string>): string[] {
  const all = [
    record.phone,
    ...splitCsv(record.phones),
    record.dex_phone, // legacy column name (pre-cleanup)
    ...splitCsv(record.dex_phones),
  ];
  const out = new Set<string>();
  for (const p of all) {
    const n = normalizePhone(p);
    if (n) out.add(n);
  }
  return [...out];
}

export function buildSheetIndex(rows: SheetRow[]): SheetIndex {
  const byResourceName = new Map<string, number>();
  const byEmail = new Map<string, number[]>();
  const byPhone = new Map<string, number[]>();

  for (const { rowIndex, record } of rows) {
    const resource = record.google_resource_name?.trim();
    if (resource) {
      byResourceName.set(resource, rowIndex);
      // Rows already bound to a Google contact are NOT eligible for re-match
      // via email/phone. The resource_name binding wins.
      continue;
    }
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

  return { byResourceName, byEmail, byPhone };
}

export function findMatch(person: GooglePerson, idx: SheetIndex): MatchResult {
  if (person.resource_name) {
    const r = idx.byResourceName.get(person.resource_name);
    if (r !== undefined) return { kind: "resource_name", rowIndex: r };
  }

  let ambiguousVia: "email" | "phone" | null = null;
  const ambiguousRows = new Set<number>();

  for (const raw of person.emails) {
    const ne = normalizeEmail(raw);
    if (!ne) continue;
    const m = idx.byEmail.get(ne);
    if (!m) continue;
    if (m.length === 1) return { kind: "email", rowIndex: m[0] };
    ambiguousVia = "email";
    for (const r of m) ambiguousRows.add(r);
  }

  for (const raw of person.phones) {
    const np = normalizePhone(raw);
    if (!np) continue;
    const m = idx.byPhone.get(np);
    if (!m) continue;
    if (m.length === 1) return { kind: "phone", rowIndex: m[0] };
    ambiguousVia ??= "phone";
    for (const r of m) ambiguousRows.add(r);
  }

  if (ambiguousVia && ambiguousRows.size > 0) {
    return { kind: "ambiguous", matches: [...ambiguousRows].sort((a, b) => a - b), via: ambiguousVia };
  }
  return { kind: "none" };
}
