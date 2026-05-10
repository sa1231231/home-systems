import { describe, expect, it } from "vitest";
import {
  MalformedExternalTargetError,
  parseSheetTarget,
  planBoolReversal,
  planCsvReversal,
} from "./contacts.js";
import type { ChangelogRow } from "../types.js";

function row(overrides: Partial<ChangelogRow> = {}): ChangelogRow {
  return {
    id: 42,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    caller: "api:contacts.add-tags",
    sessionId: "sess-x",
    operation: "contacts.add_csv.tags",
    targetKind: "contact",
    targetId: "people/c1",
    intent: null,
    beforeState: { tags: "Real Estate" },
    afterState: { tags: "Real Estate, Coaches" },
    externalTarget: "google.sheet:abc123!Sheet1!M5",
    status: "success",
    error: null,
    undoneBy: null,
    ...overrides,
  };
}

describe("parseSheetTarget", () => {
  it("splits prefix, sheetId, and range", () => {
    expect(parseSheetTarget("google.sheet:abc!Sheet1!M5")).toEqual({
      sheetId: "abc",
      range: "Sheet1!M5",
    });
  });
  it("rejects non-sheet targets", () => {
    expect(() => parseSheetTarget("not.a.sheet:xyz")).toThrow(MalformedExternalTargetError);
    expect(() => parseSheetTarget("google.sheet:onlyId")).toThrow(MalformedExternalTargetError);
    expect(() => parseSheetTarget(null)).toThrow(MalformedExternalTargetError);
  });
});

describe("planCsvReversal", () => {
  it("restores the before-state CSV value", () => {
    expect(planCsvReversal(row(), "tags")).toEqual({ range: "Sheet1!M5", value: "Real Estate" });
  });
  it("handles empty-string before values", () => {
    const r = row({ beforeState: { tags: "" } });
    expect(planCsvReversal(r, "tags")).toEqual({ range: "Sheet1!M5", value: "" });
  });
  it("throws if before_state is missing the field", () => {
    expect(() => planCsvReversal(row({ beforeState: {} }), "tags")).toThrow(/missing before_state/);
  });
});

describe("planBoolReversal", () => {
  it("restores TRUE for prior true", () => {
    const r = row({ operation: "contacts.set_bool.is_archived", beforeState: { is_archived: true } });
    expect(planBoolReversal(r, "is_archived")).toEqual({ range: "Sheet1!M5", value: "TRUE" });
  });
  it("restores FALSE for prior false", () => {
    const r = row({ operation: "contacts.set_bool.starred", beforeState: { starred: false } });
    expect(planBoolReversal(r, "starred")).toEqual({ range: "Sheet1!M5", value: "FALSE" });
  });
  it("throws if before_state field is wrong type", () => {
    const r = row({ beforeState: { is_archived: "true" } });
    expect(() => planBoolReversal(r, "is_archived")).toThrow(/missing before_state/);
  });
});
