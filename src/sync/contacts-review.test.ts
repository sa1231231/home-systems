import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { needsReview } from "../db/schema.js";
import type { GooglePerson } from "../integrations/google/people.js";
import type { SyncPlan } from "./contacts.js";
import {
  CONTACT_AMBIGUOUS_KIND,
  CONTACT_DOMAIN,
  CONTACT_INSERT_KIND,
  CONTACT_REFRESH_KIND,
  buildInsertReview,
  buildRefreshReview,
  enqueueSyncPlan,
} from "./contacts-review.js";

function person(over: Partial<GooglePerson> & { resource_name: string }): GooglePerson {
  return {
    resource_name: over.resource_name,
    display_name: over.display_name ?? "Test Person",
    given_name: over.given_name ?? null,
    family_name: over.family_name ?? null,
    emails: over.emails ?? [],
    phones: over.phones ?? [],
    updated_at: over.updated_at ?? null,
    biography: over.biography ?? null,
    birthday: over.birthday ?? null,
    birthday_year: over.birthday_year ?? null,
    job_title: over.job_title ?? null,
    company: over.company ?? null,
    image_url: over.image_url ?? null,
    linkedin_url: over.linkedin_url ?? null,
    website: over.website ?? null,
    address: over.address ?? null,
  };
}

function emptyPlan(): SyncPlan {
  return {
    spreadsheetId: "sheet1",
    tab: "Contacts",
    headers: ["google_resource_name", "full_name", "email"],
    needsHeaderUpdate: false,
    resourceNameColIndex: 0,
    inserts: [],
    refreshes: [],
    ambiguous: [],
    unchanged: 0,
  };
}

describe("buildInsertReview / buildRefreshReview", () => {
  it("insert preview carries display_name, primary_email, and proposed values", () => {
    const plan = emptyPlan();
    const p = person({ resource_name: "people/c1", display_name: "Alice", emails: ["a@b"] });
    const built = buildInsertReview({ person: p, values: ["people/c1", "Alice", "a@b"] }, plan);
    expect(built.subjectId).toBe("people/c1");
    expect(built.subject).toMatchObject({
      kind: "insert",
      display_name: "Alice",
      primary_email: "a@b",
    });
    expect(built.action).toEqual({
      type: "insert",
      tab: "Contacts",
      headers: plan.headers,
      values: ["people/c1", "Alice", "a@b"],
    });
  });

  it("refresh preview lists changed_fields and via", () => {
    const plan = emptyPlan();
    const p = person({ resource_name: "people/c2", display_name: "Bob" });
    const built = buildRefreshReview(
      {
        rowIndex: 12,
        person: p,
        via: "email",
        updates: [
          { col: "phone", from: "", to: "555" },
          { col: "company", from: "", to: "Acme" },
        ],
      },
      plan,
    );
    expect(built.subject).toMatchObject({
      kind: "refresh",
      row_index: 12,
      via: "email",
      changed_fields: ["phone", "company"],
    });
    expect(built.action).toMatchObject({
      type: "refresh",
      row_index: 12,
      via: "email",
    });
  });
});

describe("enqueueSyncPlan", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
  });

  async function pendingCount(subjectKind: string): Promise<number> {
    const rows = await db
      .select({ id: needsReview.id })
      .from(needsReview)
      .where(
        and(
          eq(needsReview.domain, CONTACT_DOMAIN),
          eq(needsReview.subjectKind, subjectKind),
          eq(needsReview.status, "pending"),
        ),
      );
      return rows.length;
  }

  it("inserts a pending needs_review row per plan item", async () => {
    const plan: SyncPlan = {
      ...emptyPlan(),
      inserts: [
        {
          person: person({ resource_name: "people/c1", display_name: "Alice" }),
          values: ["people/c1", "Alice"],
        },
      ],
      refreshes: [
        {
          rowIndex: 5,
          person: person({ resource_name: "people/c2" }),
          via: "resource_name",
          updates: [{ col: "phone", from: "", to: "555" }],
        },
      ],
      ambiguous: [
        {
          person: person({ resource_name: "people/c3" }),
          matches: [1, 2, 3],
          via: "email",
        },
      ],
    };
    const summary = await enqueueSyncPlan(plan);
    expect(summary.queued_inserts).toBe(1);
    expect(summary.queued_refreshes).toBe(1);
    expect(summary.queued_ambiguous).toBe(1);
    expect(summary.skipped_duplicates).toBe(0);
    expect(await pendingCount(CONTACT_INSERT_KIND)).toBe(1);
    expect(await pendingCount(CONTACT_REFRESH_KIND)).toBe(1);
    expect(await pendingCount(CONTACT_AMBIGUOUS_KIND)).toBe(1);
  });

  it("does not create a second pending row for the same contact (updates existing)", async () => {
    const p = person({ resource_name: "people/c1", display_name: "Alice" });
    const plan: SyncPlan = {
      ...emptyPlan(),
      inserts: [{ person: p, values: ["people/c1", "Alice"] }],
    };
    const first = await enqueueSyncPlan(plan);
    expect(first.queued_inserts).toBe(1);

    // Second run with different proposed values for the same contact.
    const plan2: SyncPlan = {
      ...emptyPlan(),
      inserts: [{ person: p, values: ["people/c1", "Alice Updated"] }],
    };
    const second = await enqueueSyncPlan(plan2);
    expect(second.queued_inserts).toBe(0);
    expect(second.skipped_duplicates).toBe(1);
    expect(await pendingCount(CONTACT_INSERT_KIND)).toBe(1);

    // The row's proposed_action should reflect the SECOND run's values.
    const [row] = await db
      .select()
      .from(needsReview)
      .where(eq(needsReview.subjectId, "people/c1"));
    const action = row.proposedAction as { values: string[] };
    expect(action.values).toEqual(["people/c1", "Alice Updated"]);
  });

  it("skips items with empty resource_name", async () => {
    const plan: SyncPlan = {
      ...emptyPlan(),
      inserts: [
        { person: person({ resource_name: "" }), values: ["", "Anon"] },
      ],
    };
    const summary = await enqueueSyncPlan(plan);
    expect(summary.queued_inserts).toBe(0);
    expect(await pendingCount(CONTACT_INSERT_KIND)).toBe(0);
  });
});
