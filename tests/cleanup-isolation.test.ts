import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "./helpers/test-db.js";
import { db } from "../src/db/client.js";
import {
  changelog,
  needsReview,
  processedEmails,
  processedTransactions,
  rules,
  aiCalls,
} from "../src/db/schema.js";

/**
 * Belt-and-suspenders check that the harness leaves no artifacts between
 * tests. Each it() inserts into a different table, and the next test's
 * beforeEach handle.reset() should wipe every table — verified by a
 * round-trip count of every table at the top of the next test.
 */
describe("test isolation", () => {
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

  async function expectAllTablesEmpty(): Promise<void> {
    expect(await db.select().from(rules)).toEqual([]);
    expect(await db.select().from(needsReview)).toEqual([]);
    expect(await db.select().from(changelog)).toEqual([]);
    expect(await db.select().from(aiCalls)).toEqual([]);
    expect(await db.select().from(processedEmails)).toEqual([]);
    expect(await db.select().from(processedTransactions)).toEqual([]);
  }

  it("starts empty (no leakage from harness setup)", async () => {
    await expectAllTablesEmpty();
  });

  it("inserts into many tables — should not leak to the next test", async () => {
    await db.insert(rules).values({
      domain: "email",
      name: "marker",
      match: { op: "present", field: "from" } as never,
      action: {} as never,
      createdBy: "test",
    });
    await db.insert(changelog).values({
      caller: "test",
      sessionId: "s",
      operation: "marker.op",
      targetKind: "thing",
      targetId: "t",
      beforeState: {} as never,
      afterState: {} as never,
      status: "success",
    });
    await db.insert(needsReview).values({
      domain: "email",
      subject: {} as never,
      subjectKind: "email",
      subjectId: "m",
      proposedAction: {} as never,
    });
    await db.insert(processedEmails).values({ id: "m", threadId: "t", outcome: "matched_rule" });
    await db.insert(processedTransactions).values({ id: "tx", outcome: "matched_rule" });
    await db.insert(aiCalls).values({
      classifier: "x",
      caller: "y",
      model: "m",
      systemPrompt: "p",
      input: "i",
      rawOutput: "r",
      effort: "low",
      status: "success",
    });
    // Sanity: rows exist within this test
    expect((await db.select().from(rules)).length).toBe(1);
  });

  it("again starts empty after the previous test inserted into every table", async () => {
    await expectAllTablesEmpty();
  });
});
