import { describe, expect, it } from "vitest";
import {
  applyMergeStrategy,
  buildMergePlan,
  type SheetRowAt,
} from "./contacts-merge.js";

function row(rowIndex: number, record: Record<string, string>): SheetRowAt {
  return { rowIndex, record };
}

describe("applyMergeStrategy", () => {
  it("union_csv dedupes case-insensitively and trims", () => {
    expect(applyMergeStrategy("union_csv", ["a@b, c@d", "A@B,  e@f"])).toBe("a@b, c@d, e@f");
  });

  it("union_csv handles empty input", () => {
    expect(applyMergeStrategy("union_csv", ["", " , ,"])).toBe("");
  });

  it("longest picks the longest trimmed value", () => {
    expect(applyMergeStrategy("longest", ["Sam", "Samuel", "  Sam "])).toBe("Samuel");
  });

  it("concat_unique joins distinct non-empty values", () => {
    expect(applyMergeStrategy("concat_unique", ["note 1", "", "note 2", "note 1"])).toBe(
      "note 1\n---\nnote 2",
    );
  });
});

describe("buildMergePlan", () => {
  const headers = [
    "first_name",
    "last_name",
    "emails",
    "phones",
    "company",
    "groups",
    "legacy_notes",
  ];

  it("picks the lowest rowIndex as keeper and lists the rest for deletion", () => {
    const plan = buildMergePlan(
      [
        row(50, { first_name: "Sam", emails: "a@b" }),
        row(10, { first_name: "Sam", emails: "a@b" }),
        row(99, { first_name: "Sam", emails: "a@b" }),
      ],
      headers,
    );
    expect(plan.keeperRowIndex).toBe(10);
    expect(plan.deleteRowIndices).toEqual([50, 99]);
  });

  it("union-CSVs emails and phones across all rows", () => {
    const plan = buildMergePlan(
      [
        row(1, { emails: "a@b.com", phones: "555-1111" }),
        row(2, { emails: "a@b.com, c@d.com", phones: "555-2222" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.emails).toBe("a@b.com, c@d.com");
    expect(cols.phones).toBe("555-1111, 555-2222");
  });

  it("picks longest for scalar identity columns (no data loss for Sam vs Samuel)", () => {
    const plan = buildMergePlan(
      [
        row(1, { first_name: "Sam", last_name: "Astra" }),
        row(2, { first_name: "Samuel", last_name: "Astra" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.first_name).toBe("Samuel");
    // last_name is identical → no update emitted
    expect("last_name" in cols).toBe(false);
  });

  it("concats legacy_notes from all rows with a separator", () => {
    const plan = buildMergePlan(
      [
        row(1, { legacy_notes: "first" }),
        row(2, { legacy_notes: "second" }),
        row(3, { legacy_notes: "first" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.legacy_notes).toBe("first\n---\nsecond");
  });

  it("never drops data from a non-keeper into the void", () => {
    const plan = buildMergePlan(
      [
        row(1, { first_name: "Bob", emails: "bob@x" }),
        row(2, { first_name: "Bob", emails: "bob@x", company: "Acme" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.company).toBe("Acme");
  });

  it("emits no update when nothing changes (idempotent)", () => {
    const r = { first_name: "X", emails: "a@b", phones: "555" };
    const plan = buildMergePlan([row(1, r), row(2, r)], headers);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteRowIndices).toEqual([2]);
  });

  it("requires at least 2 rows", () => {
    expect(() => buildMergePlan([row(1, {})], headers)).toThrow(/≥ 2 rows/);
  });

  it("prefers split first/last names over a partial name (Shawn Swarner > Swarner)", () => {
    const plan = buildMergePlan(
      [
        row(10, { first_name: "Shawn", last_name: "Swarner" }), // split, keeper
        row(20, { first_name: "Swarner", last_name: "" }), // unsplit
      ],
      headers,
    );
    expect(plan.keeperRowIndex).toBe(10);
    // Keeper already has the right values → no updates needed for names
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.first_name).toBeUndefined();
    expect(cols.last_name).toBeUndefined();
  });

  it("prefers split names even when the keeper is the unsplit row", () => {
    // The keeper is row 10 (unsplit) but the merge should still pull the
    // split first/last from row 20 because that row is the "real" split.
    const plan = buildMergePlan(
      [
        row(10, { first_name: "Swarner", last_name: "" }), // unsplit keeper
        row(20, { first_name: "Shawn", last_name: "Swarner" }), // split donor
      ],
      headers,
    );
    expect(plan.keeperRowIndex).toBe(10);
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.first_name).toBe("Shawn");
    expect(cols.last_name).toBe("Swarner");
  });

  it("prefers split names over stuffed-with-company first_name (Jeremy Span > Jeremy Span Stoneberg Management)", () => {
    const plan = buildMergePlan(
      [
        row(10, { first_name: "Jeremy Span Stoneberg Management", last_name: "" }),
        row(20, { first_name: "Jeremy", last_name: "Span" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.first_name).toBe("Jeremy");
    expect(cols.last_name).toBe("Span");
  });

  it("falls back to longest when no row has both names split", () => {
    const plan = buildMergePlan(
      [
        row(10, { first_name: "Sam", last_name: "" }),
        row(20, { first_name: "Samuel", last_name: "" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.first_name).toBe("Samuel");
  });

  it("picks the longest first_name among split rows when several qualify", () => {
    const plan = buildMergePlan(
      [
        row(10, { first_name: "Sam", last_name: "Astra" }),
        row(20, { first_name: "Samuel", last_name: "Astra" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.first_name).toBe("Samuel");
  });
});
