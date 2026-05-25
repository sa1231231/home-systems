import { afterEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
vi.mock("googleapis", () => ({
  google: { people: () => ({ people: { connections: { list: listMock } } }) },
}));

import { listConnectionsDelta, toGooglePerson } from "./people.js";

const fakeClient = {} as never;

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

describe("listConnectionsDelta", () => {
  afterEach(() => listMock.mockReset());

  it("does a full paginated fetch with no token, requesting a sync token", async () => {
    listMock
      .mockResolvedValueOnce({
        data: { connections: [{ resourceName: "people/a", names: [{ displayName: "A" }] }], nextPageToken: "p2" },
      })
      .mockResolvedValueOnce({
        data: { connections: [{ resourceName: "people/b", names: [{ displayName: "B" }] }], nextSyncToken: "TOK1" },
      });
    const r = await listConnectionsDelta(fakeClient);
    expect(r.fullSync).toBe(true);
    expect(r.persons.map((p) => p.resource_name)).toEqual(["people/a", "people/b"]);
    expect(r.deleted).toEqual([]);
    expect(r.nextSyncToken).toBe("TOK1");
    expect(listMock.mock.calls[0][0].requestSyncToken).toBe(true);
    expect(listMock.mock.calls[0][0].syncToken).toBeUndefined();
  });

  it("does a delta fetch with a token and separates deleted contacts", async () => {
    listMock.mockResolvedValueOnce({
      data: {
        connections: [
          { resourceName: "people/a", names: [{ displayName: "A" }] },
          { resourceName: "people/gone", metadata: { deleted: true } },
        ],
        nextSyncToken: "TOK2",
      },
    });
    const r = await listConnectionsDelta(fakeClient, { syncToken: "TOK1" });
    expect(r.fullSync).toBe(false);
    expect(r.persons.map((p) => p.resource_name)).toEqual(["people/a"]);
    expect(r.deleted).toEqual(["people/gone"]);
    expect(r.nextSyncToken).toBe("TOK2");
    expect(listMock.mock.calls[0][0].syncToken).toBe("TOK1");
  });

  it("falls back to a full sync when the token has expired (HTTP 410)", async () => {
    listMock
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { code: 410 }))
      .mockResolvedValueOnce({
        data: { connections: [{ resourceName: "people/a", names: [{ displayName: "A" }] }], nextSyncToken: "TOK3" },
      });
    const r = await listConnectionsDelta(fakeClient, { syncToken: "STALE" });
    expect(r.fullSync).toBe(true);
    expect(r.persons.map((p) => p.resource_name)).toEqual(["people/a"]);
    expect(r.nextSyncToken).toBe("TOK3");
  });

  it("rethrows non-410 errors", async () => {
    listMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: 500 }));
    await expect(listConnectionsDelta(fakeClient, { syncToken: "T" })).rejects.toThrow("boom");
  });

  it("falls back to a full sync when the API returns 400 with the expired-token message", async () => {
    // In practice the People API often surfaces an expired sync token as HTTP
    // 400 with the literal message "Sync token is expired. Clear local cache
    // and retry call without the sync token." — the 410 detection alone
    // misses it and the error propagates.
    listMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Sync token is expired. Clear local cache and retry call without the sync token."), {
          code: 400,
        }),
      )
      .mockResolvedValueOnce({
        data: { connections: [{ resourceName: "people/a", names: [{ displayName: "A" }] }], nextSyncToken: "TOK4" },
      });
    const r = await listConnectionsDelta(fakeClient, { syncToken: "STALE" });
    expect(r.fullSync).toBe(true);
    expect(r.nextSyncToken).toBe("TOK4");
  });
});
