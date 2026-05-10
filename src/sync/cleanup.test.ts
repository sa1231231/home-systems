import { describe, expect, it } from "vitest";
import { NEW_COLUMNS, planCleanup, transformRows } from "./cleanup.js";

describe("planCleanup", () => {
  it("classifies a typical post-Dex sheet header into renamed/kept/dropped", () => {
    const oldHeaders = [
      "full_name",
      "education", // dropped
      "linkedin", // renamed → linkedin_url
      "dex_email", // renamed → email
      "id", // dropped
      "google_resource_name",
    ];
    const plan = planCleanup(oldHeaders);
    expect(plan.kept).toEqual(["full_name", "google_resource_name"]);
    expect(plan.renamed).toEqual([
      { from: "linkedin", to: "linkedin_url" },
      { from: "dex_email", to: "email" },
    ]);
    expect(plan.dropped).toEqual(["education", "id"]);
    expect(plan.newHeaders).toEqual(NEW_COLUMNS);
    expect(plan.alreadyClean).toBe(false);
  });

  it("marks a sheet that is already in the new shape as alreadyClean", () => {
    const plan = planCleanup([...NEW_COLUMNS]);
    expect(plan.alreadyClean).toBe(true);
    expect(plan.dropped).toEqual([]);
    expect(plan.renamed).toEqual([]);
  });
});

describe("transformRows", () => {
  it("realigns row data into the new column order, preserving values across renames", () => {
    const oldHeaders = ["full_name", "dex_email", "dex_groups", "id", "google_resource_name"];
    const oldRows = [
      ["Jane Doe", "jane@example.com", "Real Estate, Coaches", "abc-123", "people/c1"],
    ];
    const result = transformRows(oldHeaders, oldRows);
    expect(result).toHaveLength(1);
    const out = result[0];
    expect(out[NEW_COLUMNS.indexOf("google_resource_name")]).toBe("people/c1");
    expect(out[NEW_COLUMNS.indexOf("full_name")]).toBe("Jane Doe");
    expect(out[NEW_COLUMNS.indexOf("email")]).toBe("jane@example.com");
    expect(out[NEW_COLUMNS.indexOf("groups")]).toBe("Real Estate, Coaches");
    // Dropped columns are simply absent from the output.
    expect(out).toHaveLength(NEW_COLUMNS.length);
  });

  it("emits empty strings for new columns missing in the old data", () => {
    const oldHeaders = ["full_name"];
    const oldRows = [["Alone"]];
    const out = transformRows(oldHeaders, oldRows)[0];
    expect(out[NEW_COLUMNS.indexOf("full_name")]).toBe("Alone");
    expect(out[NEW_COLUMNS.indexOf("google_resource_name")]).toBe("");
    expect(out[NEW_COLUMNS.indexOf("email")]).toBe("");
  });
});
