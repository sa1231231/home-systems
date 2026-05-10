import { describe, expect, it } from "vitest";
import { toGooglePerson } from "./people.js";

const NULL_EXTENDED = {
  biography: null,
  birthday: null,
  birthday_year: null,
  job_title: null,
  company: null,
  image_url: null,
  linkedin_url: null,
  website: null,
  address: null,
};

describe("toGooglePerson", () => {
  it("maps a fully populated person", () => {
    const result = toGooglePerson({
      resourceName: "people/c123",
      names: [{ displayName: "Jane Doe", givenName: "Jane", familyName: "Doe" }],
      emailAddresses: [{ value: "jane@example.com" }, { value: "jane@work.com" }],
      phoneNumbers: [{ value: "+15551234567" }],
      metadata: { sources: [{ updateTime: "2026-05-10T12:00:00Z" }] },
      biographies: [{ value: "Founder of Example.com" }],
      birthdays: [{ date: { year: 1990, month: 4, day: 15 } }],
      organizations: [{ title: "CEO", name: "Example Inc." }],
      photos: [{ url: "https://example.com/photo.jpg" }],
      urls: [
        { value: "https://www.linkedin.com/in/jane" },
        { value: "https://janedoe.com" },
      ],
      addresses: [{ formattedValue: "123 Main St, Anytown" }],
    });
    expect(result).toEqual({
      resource_name: "people/c123",
      display_name: "Jane Doe",
      given_name: "Jane",
      family_name: "Doe",
      emails: ["jane@example.com", "jane@work.com"],
      phones: ["+15551234567"],
      updated_at: "2026-05-10T12:00:00Z",
      biography: "Founder of Example.com",
      birthday: "1990-04-15",
      birthday_year: 1990,
      job_title: "CEO",
      company: "Example Inc.",
      image_url: "https://example.com/photo.jpg",
      linkedin_url: "https://www.linkedin.com/in/jane",
      website: "https://janedoe.com",
      address: "123 Main St, Anytown",
    });
  });

  it("handles a sparse person with only a display name", () => {
    const result = toGooglePerson({
      resourceName: "people/c456",
      names: [{ displayName: "Coach Long" }],
    });
    expect(result).toEqual({
      resource_name: "people/c456",
      display_name: "Coach Long",
      given_name: null,
      family_name: null,
      emails: [],
      phones: [],
      updated_at: null,
      ...NULL_EXTENDED,
    });
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

  it("formats year-less birthday as MM-DD", () => {
    const result = toGooglePerson({
      birthdays: [{ date: { month: 7, day: 4 } }],
    });
    expect(result.birthday).toBe("07-04");
    expect(result.birthday_year).toBeNull();
  });

  it("picks first linkedin url and skips it for website", () => {
    const result = toGooglePerson({
      urls: [
        { value: "https://www.linkedin.com/in/foo" },
        { value: "https://example.com" },
        { value: "https://twitter.com/foo" },
      ],
    });
    expect(result.linkedin_url).toBe("https://www.linkedin.com/in/foo");
    expect(result.website).toBe("https://example.com");
  });

  it("handles bare-domain urls", () => {
    const result = toGooglePerson({
      urls: [{ value: "janedoe.com" }],
    });
    expect(result.website).toBe("janedoe.com");
  });
});
