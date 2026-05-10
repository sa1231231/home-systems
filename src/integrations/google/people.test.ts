import { describe, expect, it } from "vitest";
import { toGooglePerson } from "./people.js";

describe("toGooglePerson", () => {
  it("maps a fully populated person", () => {
    const result = toGooglePerson({
      resourceName: "people/c123",
      names: [{ displayName: "Jane Doe", givenName: "Jane", familyName: "Doe" }],
      emailAddresses: [{ value: "jane@example.com" }, { value: "jane@work.com" }],
      phoneNumbers: [{ value: "+15551234567" }],
      metadata: { sources: [{ updateTime: "2026-05-10T12:00:00Z" }] },
    });
    expect(result).toEqual({
      resource_name: "people/c123",
      display_name: "Jane Doe",
      given_name: "Jane",
      family_name: "Doe",
      emails: ["jane@example.com", "jane@work.com"],
      phones: ["+15551234567"],
      updated_at: "2026-05-10T12:00:00Z",
    });
  });

  it("handles a sparse person with only a display name", () => {
    const result = toGooglePerson({
      resourceName: "people/c456",
      names: [{ displayName: "Coach Long" }],
    });
    expect(result.resource_name).toBe("people/c456");
    expect(result.display_name).toBe("Coach Long");
    expect(result.given_name).toBeNull();
    expect(result.family_name).toBeNull();
    expect(result.emails).toEqual([]);
    expect(result.phones).toEqual([]);
    expect(result.updated_at).toBeNull();
  });

  it("filters out empty email/phone values", () => {
    const result = toGooglePerson({
      resourceName: "people/c789",
      emailAddresses: [{ value: "ok@example.com" }, { value: "" }, {}],
      phoneNumbers: [{ value: "" }, { value: "+15550000000" }],
    });
    expect(result.emails).toEqual(["ok@example.com"]);
    expect(result.phones).toEqual(["+15550000000"]);
  });

  it("returns empty resource_name when missing (defensive)", () => {
    const result = toGooglePerson({});
    expect(result.resource_name).toBe("");
    expect(result.display_name).toBeNull();
  });
});
