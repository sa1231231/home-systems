import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { contactGroups } from "../db/schema.js";
import { listGroups, upsertGroup } from "./contact-groups.js";

describe("contact-groups", () => {
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

  it("upsertGroup returns true for new, false for existing", async () => {
    expect(await upsertGroup("Real Estate")).toBe(true);
    expect(await upsertGroup("Real Estate")).toBe(false);
  });

  it("trims whitespace from the name", async () => {
    await upsertGroup("  Coaches  ");
    const rows = await db.select().from(contactGroups);
    expect(rows[0].name).toBe("Coaches");
  });

  it("rejects empty names", async () => {
    await expect(upsertGroup("   ")).rejects.toThrow(/cannot be empty/);
  });

  it("listGroups returns only non-archived rows, ordered by sort_order then name", async () => {
    await upsertGroup("Bravo");
    await upsertGroup("Alpha");
    await upsertGroup("Charlie");
    // Archive Bravo and reorder Charlie up
    await db
      .update(contactGroups)
      .set({ archived: true })
      .where(eq(contactGroups.name, "Bravo"));
    await db
      .update(contactGroups)
      .set({ sortOrder: 50 })
      .where(eq(contactGroups.name, "Charlie"));

    const result = await listGroups();
    expect(result.map((g) => g.name)).toEqual(["Charlie", "Alpha"]);
  });
});
