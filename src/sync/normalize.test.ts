import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone, splitCsv } from "./normalize.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Jane@Example.COM ")).toBe("jane@example.com");
  });
  it("returns null for empty/missing", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("returns last 10 digits across formats", () => {
    expect(normalizePhone("(301) 787-8254")).toBe("3017878254");
    expect(normalizePhone("+13017878254")).toBe("3017878254");
    expect(normalizePhone("13017878254")).toBe("3017878254");
    expect(normalizePhone("3017878254")).toBe("3017878254");
    expect(normalizePhone("301.787.8254")).toBe("3017878254");
  });
  it("returns null for too-short or missing", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("ext 5")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
  });
  it("preserves longer-than-10 international by taking last 10", () => {
    // Caveat: this is US-centric; international numbers collapse to the local
    // 10-digit subscriber number, which still gives a useful match for personal CRMs.
    expect(normalizePhone("+44 20 7946 0958")).toBe("2079460958");
  });
});

describe("splitCsv", () => {
  it("splits comma-separated values and trims", () => {
    expect(splitCsv("Real Estate, Coaches, Personal")).toEqual(["Real Estate", "Coaches", "Personal"]);
  });
  it("handles empty/missing", () => {
    expect(splitCsv("")).toEqual([]);
    expect(splitCsv(null)).toEqual([]);
    expect(splitCsv("   ")).toEqual([]);
  });
  it("filters out empty entries", () => {
    expect(splitCsv("a, , b,")).toEqual(["a", "b"]);
  });
});
