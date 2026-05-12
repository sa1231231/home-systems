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

  it("ignores canonical rows themselves (rows with any contact info)", () => {
    const rows = [row({ full_name: "Anyone", email: "x@y" })];
    expect(findAuditIssues(rows)).toEqual({
      orphans: [],
      emptyRows: [],
      nameOnly: [],
      emailDuplicates: [],
      phoneDuplicates: [],
    });
  });

  it("treats a LinkedIn URL alone as valid contact info (not name-only)", () => {
    const rows = [row({ full_name: "Jay Anderson", linkedin_url: "https://linkedin.com/in/j" })];
    expect(findAuditIssues(rows).nameOnly).toEqual([]);
  });

  it("treats a website alone as valid contact info", () => {
    const rows = [row({ full_name: "Some Biz", website: "https://example.com" })];
    expect(findAuditIssues(rows).nameOnly).toEqual([]);
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

  it("picks the lowest row index as canonical when multiple have contact info", () => {
    const rows = [
      row({ full_name: "Twin" }), // orphan
      row({ full_name: "Twin", phone: "111" }), // canonical (winner)
      row({ full_name: "Twin", phone: "222" }), // also has contact info, but later
    ];
    const r = findAuditIssues(rows);
    expect(r.orphans[0].canonicalRowIndex).toBe(1);
  });

  it("trims whitespace when comparing names", () => {
    const rows = [
      row({ full_name: "  Spaced  " }),
      row({ full_name: "Spaced", email: "x@y" }),
    ];
    expect(findAuditIssues(rows).orphans).toHaveLength(1);
  });

  it("falls back to first_name + last_name when full_name is absent (post-column-cleanup schema)", () => {
    const rows = [
      row({ first_name: "Jay", last_name: "Hajeer" }), // orphan, no contact info
      row({ first_name: "Jay", last_name: "Hajeer", phone: "555" }), // canonical
    ];
    const r = findAuditIssues(rows);
    expect(r.orphans).toEqual([{ rowIndex: 0, fullName: "Jay Hajeer", canonicalRowIndex: 1 }]);
  });
});

describe("findAuditIssues — email/phone duplicates", () => {
  it("groups rows that share a normalized email", () => {
    const rows = [
      row({ first_name: "A", email: "Foo@Bar.com" }),
      row({ first_name: "B", emails: "foo@bar.com, baz@qux.com" }),
      row({ first_name: "C", emails: "qux@baz.com" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.emailDuplicates).toEqual([
      { value: "foo@bar.com", rowIndices: [0, 1] },
    ]);
  });

  it("groups rows that share a normalized phone (digits only, strips leading 1)", () => {
    const rows = [
      row({ first_name: "A", phone: "+1 (555) 123-4567" }),
      row({ first_name: "B", phones: "555-123-4567" }),
      row({ first_name: "C", phone: "555 9999999" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.phoneDuplicates).toEqual([
      { value: "5551234567", rowIndices: [0, 1] },
    ]);
  });

  it("does not flag a row whose own CSV repeats the same email twice", () => {
    const rows = [row({ first_name: "Solo", emails: "x@y.com, x@y.com" })];
    expect(findAuditIssues(rows).emailDuplicates).toEqual([]);
  });

  it("skips invalid email strings (must contain @)", () => {
    const rows = [
      row({ first_name: "A", emails: "broken-string" }),
      row({ first_name: "B", emails: "broken-string" }),
    ];
    expect(findAuditIssues(rows).emailDuplicates).toEqual([]);
  });

  it("skips short phone fragments (< 7 digits)", () => {
    const rows = [
      row({ first_name: "A", phones: "123" }),
      row({ first_name: "B", phones: "123" }),
    ];
    expect(findAuditIssues(rows).phoneDuplicates).toEqual([]);
  });

  it("sorts duplicate groups by cluster size descending", () => {
    const rows = [
      row({ first_name: "A", email: "a@b" }),
      row({ first_name: "B", email: "a@b" }),
      row({ first_name: "C", email: "a@b" }),
      row({ first_name: "D", email: "x@y" }),
      row({ first_name: "E", email: "x@y" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.emailDuplicates.map((g) => [g.value, g.rowIndices.length])).toEqual([
      ["a@b", 3],
      ["x@y", 2],
    ]);
  });
});
