import { describe, expect, it } from "vitest";
import { personToIdentity, planSync, summarize } from "./contacts.js";
import type { GooglePerson } from "../integrations/google/people.js";
import type { ContactsTab } from "../integrations/google/sheets.js";
import type { SnapshotFields } from "./contact-snapshots.js";

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
    expect(summarize(plan)).toEqual({ inserted: 1, refreshed: 0, unchanged: 0, ambiguous: 0, tombstoned: 0 });
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

  it("does NOT re-insert a Google contact whose sheet row the user previously deleted", () => {
    // Snapshot exists (we synced this contact in a prior run) but the sheet
    // no longer has any row carrying its google_resource_name → the user
    // deleted it. The contact must land in `tombstoned`, not `inserts`.
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "phone", "google_resource_name", "groups"],
      rows: [],
    };
    const p = person({
      resource_name: "people/c-sam",
      display_name: "Sam",
      emails: ["sam@example.com"],
    });
    const snapshots = new Map<string, SnapshotFields>([
      [
        "people/c-sam",
        { full_name: "Sam", email: "sam@example.com", emails: "sam@example.com" } as SnapshotFields,
      ],
    ]);
    const plan = planSync("sheet-123", tab, [p], NOW, snapshots);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.tombstoned).toHaveLength(1);
    expect(plan.tombstoned[0].resource_name).toBe("people/c-sam");
    expect(summarize(plan).tombstoned).toBe(1);
  });

  it("does insert a Google contact with no snapshot (first-time sight)", () => {
    // Sanity check on the tombstone guard: a brand-new Google contact (no
    // snapshot, not in sheet) is a legit insert, not a deletion.
    const tab: ContactsTab = {
      tab: "dex_contacts",
      headers: ["full_name", "email", "google_resource_name", "groups"],
      rows: [],
    };
    const p = person({
      resource_name: "people/c-new",
      display_name: "New Person",
      emails: ["new@example.com"],
    });
    const plan = planSync("sheet-123", tab, [p], NOW);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.tombstoned).toHaveLength(0);
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

describe("planSync — 3-way snapshot compare", () => {
  function tabWith(record: Record<string, string>): ContactsTab {
    return {
      tab: "dex_contacts",
      headers: ["full_name", "company", "updated_at", "google_resource_name", "groups"],
      rows: [
        {
          rowIndex: 0,
          record: {
            full_name: "",
            company: "",
            updated_at: "",
            google_resource_name: "people/c1",
            groups: "",
            ...record,
          },
        },
      ],
    };
  }
  function snapshotOf(over: Partial<GooglePerson> = {}): Map<string, SnapshotFields> {
    return new Map([
      ["people/c1", personToIdentity(person({ display_name: "Jane", company: "Acme", ...over }))],
    ]);
  }

  it("emits no change when Google matches the snapshot — a hand-edited sheet is preserved", () => {
    const tab = tabWith({ full_name: "Jane", company: "HAND EDIT" });
    const g = person({ resource_name: "people/c1", display_name: "Jane", company: "Acme" });
    const plan = planSync("s", tab, [g], NOW, snapshotOf());
    expect(plan.refreshes).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("tiers a change `auto` when Google moved and the sheet is untouched", () => {
    const tab = tabWith({ full_name: "Jane", company: "Acme" });
    const g = person({ resource_name: "people/c1", display_name: "Jane", company: "NewCo" });
    const plan = planSync("s", tab, [g], NOW, snapshotOf());
    expect(plan.refreshes[0].updates.find((u) => u.col === "company")).toMatchObject({
      from: "Acme",
      to: "NewCo",
      base: "Acme",
      tier: "auto",
    });
  });

  it("tiers a change `conflict` when Google AND the sheet both moved", () => {
    const tab = tabWith({ full_name: "Jane", company: "HAND EDIT" });
    const g = person({ resource_name: "people/c1", display_name: "Jane", company: "NewCo" });
    const plan = planSync("s", tab, [g], NOW, snapshotOf());
    expect(plan.refreshes[0].updates.find((u) => u.col === "company")).toMatchObject({
      from: "HAND EDIT",
      to: "NewCo",
      base: "Acme",
      tier: "conflict",
    });
  });

  it("tiers `first_run` when there is no snapshot for the contact", () => {
    const tab = tabWith({ full_name: "Jane", company: "Old" });
    const g = person({ resource_name: "people/c1", display_name: "Jane", company: "NewCo" });
    const plan = planSync("s", tab, [g], NOW);
    expect(plan.refreshes[0].updates.find((u) => u.col === "company")).toMatchObject({
      tier: "first_run",
    });
  });

  it("never overwrites a populated sheet field with an empty Google value", () => {
    const tab = tabWith({ full_name: "Jane", company: "Manual" });
    const g = person({ resource_name: "people/c1", display_name: "Jane" }); // company → ""
    const plan = planSync("s", tab, [g], NOW, snapshotOf());
    const companyChange = plan.refreshes
      .flatMap((r) => r.updates)
      .find((u) => u.col === "company");
    expect(companyChange).toBeUndefined();
  });
});

describe("planSync — formatting-only differences are ignored", () => {
  function rowTab(record: Record<string, string>): ContactsTab {
    return {
      tab: "dex_contacts",
      headers: [
        "full_name",
        "description",
        "email",
        "emails",
        "phone",
        "phones",
        "address",
        "updated_at",
        "google_resource_name",
        "groups",
      ],
      rows: [
        {
          rowIndex: 0,
          record: {
            full_name: "Y",
            description: "",
            email: "",
            emails: "",
            phone: "",
            phones: "",
            address: "",
            updated_at: "",
            google_resource_name: "people/c1",
            groups: "",
            ...record,
          },
        },
      ],
    };
  }
  const g = (over: Partial<GooglePerson>) =>
    person({ resource_name: "people/c1", display_name: "Y", ...over });

  it("a phone Google lists twice is not a change", () => {
    const plan = planSync(
      "s",
      rowTab({ phone: "+15714382840", phones: "+15714382840" }),
      [g({ phones: ["+15714382840", "+15714382840"] })],
      NOW,
    );
    expect(plan.refreshes).toHaveLength(0);
  });

  it("a reformatted phone (+1 vs bare digits) is not a change", () => {
    const plan = planSync(
      "s",
      rowTab({ phone: "+19498384588", phones: "+19498384588" }),
      [g({ phones: ["9498384588"] })],
      NOW,
    );
    expect(plan.refreshes).toHaveLength(0);
  });

  it("email spacing/order is not a change", () => {
    const plan = planSync(
      "s",
      rowTab({ email: "a@x.com", emails: "a@x.com,b@y.com" }),
      [g({ emails: ["a@x.com", "b@y.com"] })],
      NOW,
    );
    expect(plan.refreshes).toHaveLength(0);
  });

  it("description whitespace is not a change", () => {
    const plan = planSync(
      "s",
      rowTab({ description: "7 Ericson AisleIrvine 92620" }),
      [g({ biography: "7 Ericson Aisle\nIrvine 92620" })],
      NOW,
    );
    expect(plan.refreshes).toHaveLength(0);
  });

  it("a genuinely different address still surfaces", () => {
    const plan = planSync(
      "s",
      rowTab({ address: "74 Wonderland,Irvine,CA,92620" }),
      [g({ address: "7 Ericson Aisle\nIrvine\nCA\n92620" })],
      NOW,
    );
    expect(plan.refreshes[0].updates.some((u) => u.col === "address")).toBe(true);
  });
});
