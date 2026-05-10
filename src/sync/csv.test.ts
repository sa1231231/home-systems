import { describe, expect, it } from "vitest";
import { addToCsv, parseCsv, removeFromCsv } from "./csv.js";

describe("parseCsv", () => {
  it("splits and trims", () => {
    expect(parseCsv("a, b , c")).toEqual(["a", "b", "c"]);
  });
  it("returns [] for empty/missing", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv(null)).toEqual([]);
    expect(parseCsv(undefined)).toEqual([]);
  });
});

describe("addToCsv", () => {
  it("adds new items, preserving order", () => {
    const r = addToCsv("Real Estate", ["Coaches", "Personal"]);
    expect(r.value).toBe("Real Estate, Coaches, Personal");
    expect(r.changed).toBe(true);
  });
  it("dedupes case-insensitively (existing display form wins)", () => {
    const r = addToCsv("Real Estate", ["real estate", "REAL ESTATE"]);
    expect(r.value).toBe("Real Estate");
    expect(r.changed).toBe(false);
  });
  it("dedupes within additions", () => {
    const r = addToCsv("", ["A", "a", "B"]);
    expect(r.value).toBe("A, B");
    expect(r.changed).toBe(true);
  });
  it("trims input items, skips empties", () => {
    const r = addToCsv("", ["  Real Estate  ", "", "  "]);
    expect(r.value).toBe("Real Estate");
    expect(r.changed).toBe(true);
  });
  it("returns unchanged when all additions are already present", () => {
    const r = addToCsv("A, B", ["a", "b"]);
    expect(r.value).toBe("A, B");
    expect(r.changed).toBe(false);
  });
});

describe("removeFromCsv", () => {
  it("removes specified items, case-insensitively", () => {
    const r = removeFromCsv("Real Estate, Coaches, Personal", ["coaches"]);
    expect(r.value).toBe("Real Estate, Personal");
    expect(r.changed).toBe(true);
  });
  it("returns unchanged when item not present", () => {
    const r = removeFromCsv("A, B", ["C"]);
    expect(r.value).toBe("A, B");
    expect(r.changed).toBe(false);
  });
  it("returns unchanged for empty removal list", () => {
    const r = removeFromCsv("A, B", []);
    expect(r.value).toBe("A, B");
    expect(r.changed).toBe(false);
  });
  it("removes multiple at once", () => {
    const r = removeFromCsv("A, B, C", ["a", "C"]);
    expect(r.value).toBe("B");
    expect(r.changed).toBe(true);
  });
});
