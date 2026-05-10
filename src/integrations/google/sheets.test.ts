import { describe, expect, it } from "vitest";
import { colLetter, rowsToRecords } from "./sheets.js";

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

describe("colLetter", () => {
  it("maps single-letter columns A-Z", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(1)).toBe("B");
    expect(colLetter(25)).toBe("Z");
  });
  it("maps double-letter columns", () => {
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(27)).toBe("AB");
    expect(colLetter(51)).toBe("AZ");
    expect(colLetter(52)).toBe("BA");
    expect(colLetter(58)).toBe("BG"); // typical position for a 59th column (0-indexed 58)
    expect(colLetter(701)).toBe("ZZ");
  });
});
