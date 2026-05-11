import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "./helpers/test-db.js";
import { db } from "../src/db/client.js";
import { rules } from "../src/db/schema.js";

describe("test harness", () => {
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

  it("starts with empty rules table", async () => {
    const rows = await db.select().from(rules);
    expect(rows).toEqual([]);
  });

  it("persists writes through the app's db singleton", async () => {
    await db.insert(rules).values({
      domain: "email",
      name: "test rule",
      match: { op: "present", field: "from" } as never,
      action: { add_labels: ["x"] } as never,
      createdBy: "test",
    });
    const rows = await db.select().from(rules);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "test rule", domain: "email", createdBy: "test" });
  });

  it("reset() truncates between tests", async () => {
    // The previous test inserted a row. reset() in beforeEach should have wiped it.
    const rows = await db.select().from(rules);
    expect(rows).toEqual([]);
  });
});
