import { describe, expect, it } from "vitest";
import {
  findAuditIssues,
  findDuplicateNameGroups,
  findNoGroupRows,
  type SheetRow,
} from "./contacts-audit.js";

function row(over: Partial<SheetRow>): SheetRow {
  return { google_resource_name: "", full_name: "", email: "", phone: "", ...over };
}

describe("findDuplicateNameGroups", () => {
  it("pairs a name-only row with its resource-name twin; keeper = resource-name row", () => {
    const rows = [
      { rowIndex: 4, record: row({ full_name: "Haven AQ" }) },
      {
        rowIndex: 2712,
        record: row({ full_name: "Haven AQ", google_resource_name: "people/c8353", phone: "323" }),
      },
    ];
    expect(findDuplicateNameGroups(rows)).toEqual([
      { name: "haven aq", keeperRowIndex: 2712, duplicateRowIndices: [4] },
    ]);
  });

  it("skips a group with no resource-name row", () => {
    const rows = [
      { rowIndex: 0, record: row({ full_name: "Twin Hector" }) },
      { rowIndex: 1, record: row({ full_name: "Twin Hector" }) },
    ];
    expect(findDuplicateNameGroups(rows)).toEqual([]);
  });

  it("skips a group with two resource-name rows (needs human judgment)", () => {
    const rows = [
      { rowIndex: 0, record: row({ full_name: "Cigna", google_resource_name: "people/a" }) },
      { rowIndex: 1, record: row({ full_name: "Cigna", google_resource_name: "people/b" }) },
    ];
    expect(findDuplicateNameGroups(rows)).toEqual([]);
  });

  it("ignores unique names", () => {
    const rows = [
      { rowIndex: 0, record: row({ full_name: "Solo", google_resource_name: "people/x" }) },
    ];
    expect(findDuplicateNameGroups(rows)).toEqual([]);
  });
});

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
    // Row has groups assigned so it isn't flagged as no-group either.
    const rows = [row({ full_name: "Anyone", email: "x@y", groups: "Friends" })];
    expect(findAuditIssues(rows)).toEqual({
      orphans: [],
      emptyRows: [],
      nameOnly: [],
      emailDuplicates: [],
      phoneDuplicates: [],
      noGroup: [],
    });
  });

  it("treats a website alone as valid contact info", () => {
    const rows = [row({ full_name: "Some Biz", website: "https://example.com" })];
    expect(findAuditIssues(rows).nameOnly).toEqual([]);
  });

  it("treats a value in the linkedin or instagram column as valid contact info", () => {
    expect(findAuditIssues([row({ full_name: "A", linkedin: "https://linkedin.com/in/a" })]).nameOnly).toEqual([]);
    expect(findAuditIssues([row({ full_name: "B", instagram: "https://instagram.com/b" })]).nameOnly).toEqual([]);
  });

  it("treats a LinkedIn/Instagram URL in description as valid contact info", () => {
    const cases = [
      row({ full_name: "Jay", description: "https://www.instagram.com/jay/" }),
      row({ full_name: "Pat", description: "linkedin.com/in/pat" }),
      row({ full_name: "Sam", description: "Met at conference, see https://example.com" }),
    ];
    for (const r of cases) {
      expect(findAuditIssues([r]).nameOnly).toEqual([]);
    }
  });

  it("still flags rows with description but no URL/handle as name-only", () => {
    const rows = [row({ full_name: "No Link", description: "Met at coffee" })];
    expect(findAuditIssues(rows).nameOnly).toHaveLength(1);
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
});

describe("findAuditIssues — email/phone duplicates", () => {
  it("groups rows that share a normalized email", () => {
    const rows = [
      row({ full_name: "A", email: "Foo@Bar.com" }),
      row({ full_name: "B", emails: "foo@bar.com, baz@qux.com" }),
      row({ full_name: "C", emails: "qux@baz.com" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.emailDuplicates).toEqual([
      { value: "foo@bar.com", rowIndices: [0, 1] },
    ]);
  });

  it("groups rows that share a normalized phone (digits only, strips leading 1)", () => {
    const rows = [
      row({ full_name: "A", phone: "+1 (555) 123-4567" }),
      row({ full_name: "B", phones: "555-123-4567" }),
      row({ full_name: "C", phone: "555 9999999" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.phoneDuplicates).toEqual([
      { value: "5551234567", rowIndices: [0, 1] },
    ]);
  });

  it("does not flag a row whose own CSV repeats the same email twice", () => {
    const rows = [row({ full_name: "Solo", emails: "x@y.com, x@y.com" })];
    expect(findAuditIssues(rows).emailDuplicates).toEqual([]);
  });

  it("skips invalid email strings (must contain @)", () => {
    const rows = [
      row({ full_name: "A", emails: "broken-string" }),
      row({ full_name: "B", emails: "broken-string" }),
    ];
    expect(findAuditIssues(rows).emailDuplicates).toEqual([]);
  });

  it("skips short phone fragments (< 7 digits)", () => {
    const rows = [
      row({ full_name: "A", phones: "123" }),
      row({ full_name: "B", phones: "123" }),
    ];
    expect(findAuditIssues(rows).phoneDuplicates).toEqual([]);
  });

  it("sorts duplicate groups by cluster size descending", () => {
    const rows = [
      row({ full_name: "A", email: "a@b" }),
      row({ full_name: "B", email: "a@b" }),
      row({ full_name: "C", email: "a@b" }),
      row({ full_name: "D", email: "x@y" }),
      row({ full_name: "E", email: "x@y" }),
    ];
    const r = findAuditIssues(rows);
    expect(r.emailDuplicates.map((g) => [g.value, g.rowIndices.length])).toEqual([
      ["a@b", 3],
      ["x@y", 2],
    ]);
  });
});

describe("findNoGroupRows", () => {
  it("flags rows with a full_name and no value in groups", () => {
    const rows = [
      row({ full_name: "Needs Group", email: "x@y.com", company: "Acme" }),
      row({ full_name: "Has Group", email: "y@z.com", groups: "Friends" }),
      row({ full_name: "" }), // no name → skipped
    ];
    expect(findNoGroupRows(rows)).toEqual([
      {
        rowIndex: 0,
        fullName: "Needs Group",
        primaryEmail: "x@y.com",
        primaryPhone: "",
        company: "Acme",
        resourceName: "",
      },
    ]);
  });

  it("includes resourceName when present", () => {
    const rows = [
      row({ full_name: "With ID", email: "x@y.com", google_resource_name: "people/c1" }),
    ];
    expect(findNoGroupRows(rows)[0].resourceName).toBe("people/c1");
  });

  it("treats whitespace-only groups as empty", () => {
    const rows = [row({ full_name: "Whitespace", email: "x@y.com", groups: "   " })];
    expect(findNoGroupRows(rows)).toHaveLength(1);
  });

  it("preserves primary_phone/email when only legacy column populated", () => {
    const rows = [
      row({ full_name: "Has Phones CSV", phones: "555-1111, 555-2222" }),
    ];
    expect(findNoGroupRows(rows)[0].primaryPhone).toBe("555-1111, 555-2222");
  });
});
