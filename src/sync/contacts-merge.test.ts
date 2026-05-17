import { describe, expect, it } from "vitest";
import {
  applyMergeStrategy,
  buildMergePlan,
  isCompanySuffix,
  pickBetterName,
  type SheetRowAt,
} from "./contacts-merge.js";

function row(rowIndex: number, record: Record<string, string>): SheetRowAt {
  return { rowIndex, record };
}

describe("buildMergePlan keeper selection", () => {
  it("defaults the keeper to the lowest row index", () => {
    const plan = buildMergePlan(
      [row(7, { full_name: "X" }), row(2, { full_name: "X" })],
      ["full_name"],
    );
    expect(plan.keeperRowIndex).toBe(2);
    expect(plan.deleteRowIndices).toEqual([7]);
  });

  it("honors an explicit keeperRowIndex even when it is not the lowest", () => {
    const plan = buildMergePlan(
      [
        row(2, { full_name: "Haven AQ", phone: "", google_resource_name: "" }),
        row(7, { full_name: "Haven AQ", phone: "555-1234", google_resource_name: "people/c1" }),
      ],
      ["full_name", "phone", "google_resource_name"],
      { keeperRowIndex: 7 },
    );
    expect(plan.keeperRowIndex).toBe(7);
    expect(plan.deleteRowIndices).toEqual([2]);
  });

  it("throws if keeperRowIndex is not among the rows", () => {
    expect(() =>
      buildMergePlan([row(2, { full_name: "X" }), row(7, { full_name: "X" })], ["full_name"], {
        keeperRowIndex: 99,
      }),
    ).toThrow();
  });
});

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

describe("pickBetterName + isCompanySuffix", () => {
  it("recognizes 'Aguilera Law Center' as 'Aguilera + company suffix'", () => {
    expect(isCompanySuffix("Aguilera Law Center", "Aguilera")).toBe(true);
    expect(pickBetterName(["Aguilera Law Center", "Aguilera"])).toBe("Aguilera");
  });

  it("keeps hyphenated/compound surnames (no company suffix token)", () => {
    expect(pickBetterName(["Wymore", "Wymore-Kirkland"])).toBe("Wymore-Kirkland");
  });

  it("picks longer name when neither is a company suffix variant", () => {
    expect(pickBetterName(["Sam", "Samuel"])).toBe("Samuel");
  });
});

describe("buildMergePlan", () => {
  const headers = ["full_name", "emails", "phones", "company", "groups", "tags", "legacy_notes"];

  it("picks the lowest rowIndex as keeper and lists the rest for deletion", () => {
    const plan = buildMergePlan(
      [
        row(50, { full_name: "Sam Astra", emails: "a@b" }),
        row(10, { full_name: "Sam Astra", emails: "a@b" }),
        row(99, { full_name: "Sam Astra", emails: "a@b" }),
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

  it("unions groups across rows", () => {
    const plan = buildMergePlan(
      [
        row(1, { groups: "Friends, Real Estate" }),
        row(2, { groups: "Real Estate, Coaches" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.groups).toBe("Friends, Real Estate, Coaches");
  });

  it("picks the cleaner form when one row has '<name> + company suffix'", () => {
    // Aguilera vs Aguilera Law Center: pickBetterName recognizes the suffix
    // and prefers the bare surname.
    const plan = buildMergePlan(
      [
        row(1, { full_name: "Aguilera Law Center" }),
        row(2, { full_name: "Aguilera" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.full_name).toBe("Aguilera");
  });

  it("falls back to longest full_name when no company-suffix relationship", () => {
    const plan = buildMergePlan(
      [
        row(1, { full_name: "Sam" }),
        row(2, { full_name: "Samuel Astra" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.full_name).toBe("Samuel Astra");
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
        row(1, { full_name: "Bob", emails: "bob@x" }),
        row(2, { full_name: "Bob", emails: "bob@x", company: "Acme" }),
      ],
      headers,
    );
    const cols = Object.fromEntries(plan.updates.map((u) => [u.col, u.to]));
    expect(cols.company).toBe("Acme");
  });

  it("emits no update when nothing changes (idempotent)", () => {
    const r = { full_name: "Sam Astra", emails: "a@b", phones: "555" };
    const plan = buildMergePlan([row(1, r), row(2, r)], headers);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteRowIndices).toEqual([2]);
  });

  it("requires at least 2 rows", () => {
    expect(() => buildMergePlan([row(1, {})], headers)).toThrow(/≥ 2 rows/);
  });
});
