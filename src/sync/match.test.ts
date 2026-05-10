import { describe, expect, it } from "vitest";
import { buildSheetIndex, findMatch } from "./match.js";
import type { GooglePerson } from "../integrations/google/people.js";

function person(overrides: Partial<GooglePerson> = {}): GooglePerson {
  return {
    resource_name: "people/c000",
    display_name: "Test",
    given_name: null,
    family_name: null,
    emails: [],
    phones: [],
    updated_at: null,
    biography: null,
    birthday: null,
    birthday_year: null,
    job_title: null,
    company: null,
    image_url: null,
    linkedin_url: null,
    website: null,
    address: null,
    ...overrides,
  };
}

describe("buildSheetIndex", () => {
  it("indexes rows without resource_name by email and phone", () => {
    const idx = buildSheetIndex([
      { rowIndex: 0, record: { dex_email: "Jane@Example.com", dex_phone: "(301) 787-8254" } },
      { rowIndex: 1, record: { dex_email: "bob@example.com", dex_phones: "+13017878254, 4155551234" } },
    ]);
    expect(idx.byResourceName.size).toBe(0);
    expect(idx.byEmail.get("jane@example.com")).toEqual([0]);
    expect(idx.byEmail.get("bob@example.com")).toEqual([1]);
    expect(idx.byPhone.get("3017878254")).toEqual([0, 1]);
    expect(idx.byPhone.get("4155551234")).toEqual([1]);
  });

  it("excludes rows with resource_name from email/phone indices", () => {
    const idx = buildSheetIndex([
      { rowIndex: 0, record: { google_resource_name: "people/c1", dex_email: "jane@example.com" } },
      { rowIndex: 1, record: { dex_email: "bob@example.com" } },
    ]);
    expect(idx.byResourceName.get("people/c1")).toBe(0);
    expect(idx.byEmail.has("jane@example.com")).toBe(false);
    expect(idx.byEmail.get("bob@example.com")).toEqual([1]);
  });
});

describe("findMatch", () => {
  it("prefers resource_name match", () => {
    const idx = buildSheetIndex([
      { rowIndex: 0, record: { google_resource_name: "people/c1", dex_email: "jane@example.com" } },
      { rowIndex: 1, record: { dex_email: "jane@example.com" } },
    ]);
    const result = findMatch(person({ resource_name: "people/c1", emails: ["jane@example.com"] }), idx);
    expect(result).toEqual({ kind: "resource_name", rowIndex: 0 });
  });

  it("falls back to unique email match", () => {
    const idx = buildSheetIndex([{ rowIndex: 5, record: { dex_email: "Jane@Example.com" } }]);
    const result = findMatch(person({ resource_name: "people/c2", emails: ["jane@example.com"] }), idx);
    expect(result).toEqual({ kind: "email", rowIndex: 5 });
  });

  it("falls back to phone match when email doesn't hit", () => {
    const idx = buildSheetIndex([{ rowIndex: 7, record: { dex_phone: "(301) 787-8254" } }]);
    const result = findMatch(person({ phones: ["+13017878254"] }), idx);
    expect(result).toEqual({ kind: "phone", rowIndex: 7 });
  });

  it("returns ambiguous when email matches multiple rows", () => {
    const idx = buildSheetIndex([
      { rowIndex: 1, record: { dex_email: "shared@example.com" } },
      { rowIndex: 2, record: { dex_email: "shared@example.com" } },
    ]);
    const result = findMatch(person({ emails: ["shared@example.com"] }), idx);
    expect(result).toEqual({ kind: "ambiguous", matches: [1, 2], via: "email" });
  });

  it("returns none when nothing matches", () => {
    const idx = buildSheetIndex([{ rowIndex: 0, record: { dex_email: "other@example.com" } }]);
    const result = findMatch(person({ emails: ["unknown@example.com"], phones: ["5551111"] }), idx);
    expect(result).toEqual({ kind: "none" });
  });

  it("handles a person with no contact data", () => {
    const idx = buildSheetIndex([{ rowIndex: 0, record: { dex_email: "x@example.com" } }]);
    const result = findMatch(person({ emails: [], phones: [] }), idx);
    expect(result).toEqual({ kind: "none" });
  });
});
