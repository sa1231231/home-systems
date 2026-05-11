import { describe, expect, it } from "vitest";
import { findAuditIssues, type SheetRow } from "./contacts-audit.js";

function row(over: Partial<SheetRow>): SheetRow {
  return { google_resource_name: "", full_name: "", email: "", phone: "", ...over };
}

describe("findAuditIssues", () => {
  it("flags an orphan row whose full_name matches a canonical row", () => {
    const rows = [
      row({ full_name: "Clippers 4.0" }), // orphan
      row({ google_resource_name: "people/c1", full_name: "Clippers 4.0", phone: "555" }), // canonical
    ];
    const r = findAuditIssues(rows);
    expect(r.orphans).toEqual([{ rowIndex: 0, fullName: "Clippers 4.0", canonicalRowIndex: 1 }]);
    expect(r.emptyRows).toEqual([]);
    expect(r.nameOnly).toEqual([]);
  });

  it("flags multiple orphans pointing at the same canonical", () => {
    const rows = [
      row({ full_name: "Dave Fox" }),
      row({ google_resource_name: "people/x", full_name: "Dave Fox", phone: "1" }),
      row({ full_name: "Dave Fox" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.orphans).toEqual([
      { rowIndex: 0, fullName: "Dave Fox", canonicalRowIndex: 1 },
      { rowIndex: 2, fullName: "Dave Fox", canonicalRowIndex: 1 },
    ]);
  });

  it("ignores canonical rows themselves", () => {
    const rows = [row({ google_resource_name: "people/x", full_name: "Anyone" })];
    expect(findAuditIssues(rows)).toEqual({ orphans: [], emptyRows: [], nameOnly: [] });
  });

  it("flags fully-empty rows separately", () => {
    const rows = [row({}), row({ google_resource_name: "p/x", full_name: "Bob" })];
    expect(findAuditIssues(rows).emptyRows).toEqual([{ rowIndex: 0 }]);
  });

  it("flags name-only rows with no contact info and no canonical match", () => {
    const rows = [row({ full_name: "Lonely Name" })];
    const r = findAuditIssues(rows);
    expect(r.orphans).toEqual([]);
    expect(r.nameOnly).toEqual([{ rowIndex: 0, fullName: "Lonely Name" }]);
  });

  it("does NOT flag name-only rows as 'nameOnly' if they have contact info", () => {
    const rows = [row({ full_name: "Has Email", email: "x@y.com" })];
    const r = findAuditIssues(rows);
    expect(r.nameOnly).toEqual([]);
  });

  it("picks the lowest row index as canonical when multiple have resource_name", () => {
    const rows = [
      row({ full_name: "Twin" }), // orphan
      row({ google_resource_name: "people/a", full_name: "Twin" }), // canonical (winner)
      row({ google_resource_name: "people/b", full_name: "Twin" }), // also canonical, later
    ];
    const r = findAuditIssues(rows);
    expect(r.orphans[0].canonicalRowIndex).toBe(1);
  });

  it("trims whitespace when comparing names", () => {
    const rows = [
      row({ full_name: "  Spaced  " }),
      row({ google_resource_name: "people/x", full_name: "Spaced" }),
    ];
    expect(findAuditIssues(rows).orphans).toHaveLength(1);
  });
});
