import { describe, expect, it } from "vitest";
import { rowsToRecords } from "./sheets.js";

describe("rowsToRecords", () => {
  it("zips headers with row values", () => {
    const result = rowsToRecords(
      ["full_name", "dex_groups"],
      [
        ["Jane Doe", "Real Estate"],
        ["Coach Long", "Coaches,Personal"],
      ],
    );
    expect(result).toEqual([
      { full_name: "Jane Doe", dex_groups: "Real Estate" },
      { full_name: "Coach Long", dex_groups: "Coaches,Personal" },
    ]);
  });

  it("fills missing trailing cells with empty strings", () => {
    const result = rowsToRecords(["a", "b", "c"], [["1", "2"]]);
    expect(result).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("returns an empty array for no rows", () => {
    expect(rowsToRecords(["a"], [])).toEqual([]);
  });
});
