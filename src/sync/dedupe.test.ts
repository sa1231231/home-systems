import { describe, expect, it } from "vitest";
import { buildMerge, findClusters, pickCanonical, planDedupe } from "./dedupe.js";
import type { SheetRow } from "./match.js";

function row(rowIndex: number, record: Record<string, string>): SheetRow {
  return { rowIndex, record };
}

describe("findClusters", () => {
  it("groups rows that share an email", () => {
    const rows = [
      row(0, { email: "shared@example.com", full_name: "Jane A" }),
      row(1, { email: "shared@example.com", full_name: "Jane B" }),
      row(2, { email: "other@example.com" }),
    ];
    const clusters = findClusters(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rowIndices).toEqual([0, 1]);
    expect(clusters[0].sharedEmails).toEqual(["shared@example.com"]);
  });

  it("groups rows that share a phone (normalized)", () => {
    const rows = [
      row(5, { phone: "(301) 787-8254" }),
      row(6, { phone: "+13017878254" }),
    ];
    const clusters = findClusters(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rowIndices).toEqual([5, 6]);
    expect(clusters[0].sharedPhones).toEqual(["3017878254"]);
  });

  it("transitively unions rows across email+phone bridges", () => {
    const rows = [
      row(1, { email: "a@example.com" }),
      row(2, { email: "a@example.com", phone: "5551234567" }),
      row(3, { phone: "+15551234567" }),
    ];
    const clusters = findClusters(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rowIndices).toEqual([1, 2, 3]);
  });

  it("ignores singletons", () => {
    const rows = [row(0, { email: "alone@example.com" }), row(1, { email: "solo@example.com" })];
    expect(findClusters(rows)).toEqual([]);
  });

  it("supports legacy column names (dex_email/dex_phone)", () => {
    const rows = [
      row(0, { dex_email: "shared@example.com" }),
      row(1, { email: "shared@example.com" }),
    ];
    const clusters = findClusters(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rowIndices).toEqual([0, 1]);
  });
});

describe("pickCanonical", () => {
  it("prefers a row with google_resource_name set", () => {
    const rows = [
      row(0, { full_name: "Jane A", phone: "5551111111" }),
      row(1, { full_name: "Jane B", phone: "5551111111", google_resource_name: "people/c1" }),
    ];
    const clusters = findClusters(rows);
    expect(pickCanonical(rows, clusters[0])).toBe(1);
  });

  it("falls back to the row with the most non-empty fields", () => {
    const rows = [
      row(0, { email: "x@example.com" }),
      row(1, { email: "x@example.com", full_name: "Jane", phone: "5551111111" }),
    ];
    const clusters = findClusters(rows);
    expect(pickCanonical(rows, clusters[0])).toBe(1);
  });

  it("breaks ties on the lowest row index", () => {
    const rows = [
      row(7, { email: "x@example.com", full_name: "A" }),
      row(3, { email: "x@example.com", full_name: "B" }),
    ];
    const clusters = findClusters(rows);
    expect(pickCanonical(rows, clusters[0])).toBe(3);
  });
});

describe("buildMerge", () => {
  it("fills empty canonical cells from duplicates without overwriting", () => {
    const rows = [
      row(0, { email: "x@example.com", full_name: "Canonical Name", phone: "" }),
      row(1, { email: "x@example.com", full_name: "Other Name", phone: "5551111111", company: "Acme" }),
    ];
    const merge = buildMerge(rows, findClusters(rows)[0]);
    expect(merge.canonicalRowIndex).toBe(1); // duplicate has more fields
    expect(merge.fills.full_name).toBeUndefined(); // canonical (row 1) already has full_name
    expect(merge.fills.phone).toBeUndefined(); // canonical has phone
  });

  it("does not overwrite the canonical's existing values", () => {
    const rows = [
      row(0, { email: "x@example.com", full_name: "Canonical", company: "FirstCo" }),
      row(1, { email: "x@example.com", full_name: "Other", company: "SecondCo" }),
    ];
    const merge = buildMerge(rows, findClusters(rows)[0]);
    expect(merge.fills.company).toBeUndefined();
  });

  it("concatenates legacy_notes from all rows in the cluster", () => {
    const rows = [
      row(0, { email: "x@example.com", legacy_notes: "instagram: jane" }),
      row(1, { email: "x@example.com", legacy_notes: "facebook: jane.fb", full_name: "Jane" }),
    ];
    const merge = buildMerge(rows, findClusters(rows)[0]);
    expect(merge.canonicalRowIndex).toBe(1);
    expect(merge.fills.legacy_notes).toBe("facebook: jane.fb\n---\ninstagram: jane");
  });

  it("schedules non-canonical rows for deletion", () => {
    const rows = [
      row(0, { email: "x@example.com" }),
      row(1, { email: "x@example.com", full_name: "Jane" }),
      row(2, { email: "x@example.com" }),
    ];
    const merge = buildMerge(rows, findClusters(rows)[0]);
    expect(merge.canonicalRowIndex).toBe(1);
    expect(merge.duplicateRowIndices).toEqual([0, 2]);
  });
});

describe("planDedupe", () => {
  it("returns one merge per cluster and sorts rowsToDelete", () => {
    const rows = [
      row(0, { email: "a@example.com" }),
      row(1, { email: "a@example.com", full_name: "Canon A" }),
      row(2, { email: "b@example.com" }),
      row(3, { email: "b@example.com", full_name: "Canon B" }),
      row(4, { email: "alone@example.com" }),
    ];
    const plan = planDedupe(rows);
    expect(plan.clusters).toHaveLength(2);
    expect(plan.merges).toHaveLength(2);
    expect(plan.rowsToDelete.sort()).toEqual([0, 2]); // canonical = 1 and 3
  });
});
