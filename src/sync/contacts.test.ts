import { describe, expect, it } from "vitest";
import { planSync, summarize } from "./contacts.js";
import type { GooglePerson } from "../integrations/google/people.js";
import type { ContactsTab } from "../integrations/google/sheets.js";

function person(overrides: Partial<GooglePerson> = {}): GooglePerson {
  return {
    resource_name: "people/c000",
    display_name: null,
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

const NOW = "2026-05-10T12:00:00.000Z";

describe("planSync", () => {
  it("auto-re-adds the google_resource_name column when missing", () => {
    // google_resource_name is the stable Google ID — required for deterministic
    // dedupe. planSync re-adds it as the last column if the sheet is missing
    // it (the column can be hidden in the Sheets UI to keep things clean).
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "groups"],
      rows: [],
    };
    const p = person({
      resource_name: "people/c1",
      display_name: "Jane Doe",
      given_name: "Jane",
      family_name: "Doe",
      emails: ["jane@example.com"],
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.needsHeaderUpdate).toBe(true);
    expect(plan.resourceNameColIndex).toBe(3);
    expect(plan.headers).toEqual(["full_name", "email", "groups", "google_resource_name"]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0].values).toEqual(["Jane Doe", "jane@example.com", "", "people/c1"]);
    expect(summarize(plan)).toEqual({ inserted: 1, refreshed: 0, unchanged: 0, ambiguous: 0 });
  });

  it("matches a name-only sheet row as a name_weak refresh when the contact has a phone", () => {
    // Pre-fix: a contact with a phone skipped name-matching, found nothing,
    // and the sync inserted a duplicate. Now it matches the name-only row as
    // name_weak — queued for review, carrying the resource_name binding.
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "phone", "updated_at", "google_resource_name", "groups"],
      rows: [
        {
          rowIndex: 0,
          record: {
            full_name: "Haven AQ",
            phone: "",
            updated_at: "",
            google_resource_name: "",
            groups: "",
          },
        },
      ],
    };
    const p = person({
      resource_name: "people/c8353",
      display_name: "Haven AQ",
      phones: ["(323) 620-7906"],
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.refreshes).toHaveLength(1);
    expect(plan.refreshes[0].via).toBe("name_weak");
    expect(plan.refreshes[0].updates.some((u) => u.col === "google_resource_name")).toBe(true);
  });

  it("refreshes a row matched by email, binding google_resource_name", () => {
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "phone", "updated_at", "google_resource_name", "groups"],
      rows: [
        {
          rowIndex: 0,
          record: {
            full_name: "Old Name",
            email: "jane@example.com",
            phone: "",
            updated_at: "2025-01-01T00:00:00Z",
            google_resource_name: "",
            groups: "Real Estate",
          },
        },
      ],
    };
    const p = person({
      resource_name: "people/c1",
      display_name: "Jane Doe",
      emails: ["jane@example.com"],
      phones: ["(301) 787-8254"],
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.needsHeaderUpdate).toBe(false);
    expect(plan.refreshes).toHaveLength(1);
    const r = plan.refreshes[0];
    expect(r.via).toBe("email");
    expect(r.rowIndex).toBe(0);
    const cols = r.updates.map((u) => u.col);
    expect(cols).toContain("full_name");
    expect(cols).toContain("phone");
    expect(cols).toContain("google_resource_name");
    expect(cols).toContain("updated_at");
    // groups must NOT be in updates (enrichment is preserved)
    expect(cols).not.toContain("groups");
  });

  it("counts a row as unchanged when Google data matches Sheet exactly", () => {
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "google_resource_name"],
      rows: [
        {
          rowIndex: 0,
          record: { full_name: "Jane", email: "jane@example.com", google_resource_name: "people/c1" },
        },
      ],
    };
    const p = person({
      resource_name: "people/c1",
      display_name: "Jane",
      emails: ["jane@example.com"],
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.unchanged).toBe(1);
    expect(plan.refreshes).toHaveLength(0);
  });

  it("flags ambiguous matches when an email maps to multiple unbound rows", () => {
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "google_resource_name"],
      rows: [
        { rowIndex: 0, record: { full_name: "Jane A", email: "shared@example.com", google_resource_name: "" } },
        { rowIndex: 1, record: { full_name: "Jane B", email: "shared@example.com", google_resource_name: "" } },
      ],
    };
    const p = person({ resource_name: "people/c1", emails: ["shared@example.com"] });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].matches).toEqual([0, 1]);
    expect(plan.ambiguous[0].via).toBe("email");
    expect(plan.refreshes).toHaveLength(0);
    expect(plan.inserts).toHaveLength(0);
  });

  it("does not overwrite existing Sheet data with empty Google values", () => {
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "phone", "google_resource_name"],
      rows: [
        {
          rowIndex: 0,
          record: { full_name: "Jane", phone: "5551234", google_resource_name: "people/c1" },
        },
      ],
    };
    const p = person({
      resource_name: "people/c1",
      display_name: "Jane",
      emails: [],
      phones: [], // Google has nothing — Sheet's 5551234 should be preserved
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.unchanged).toBe(1);
    expect(plan.refreshes).toHaveLength(0);
  });

  it("matches by phone when email doesn't match", () => {
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "phone", "google_resource_name"],
      rows: [
        { rowIndex: 0, record: { full_name: "Old", email: "old@example.com", phone: "(301) 787-8254", google_resource_name: "" } },
      ],
    };
    const p = person({
      resource_name: "people/c1",
      display_name: "New",
      emails: ["new@example.com"],
      phones: ["+13017878254"],
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.refreshes).toHaveLength(1);
    expect(plan.refreshes[0].via).toBe("phone");
  });

  it("skips Google persons without a resource_name (defensive)", () => {
    const tab: ContactsTab = { tab: "dex_contacts", headers: ["full_name", "google_resource_name"], rows: [] };
    const p = person({ resource_name: "" });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.refreshes).toHaveLength(0);
  });
});
