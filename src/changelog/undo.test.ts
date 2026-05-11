import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import {
  EntryNotFoundError,
  NotReversibleError,
  reverseOne,
} from "./undo.js";
import { ReverserRegistry } from "./reversers.js";

describe("reverseOne", () => {
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

  async function insertEntry(overrides: Partial<typeof changelog.$inferInsert> = {}): Promise<number> {
    const [row] = await db
      .insert(changelog)
      .values({
        caller: "test",
        sessionId: "s1",
        operation: "test.op",
        targetKind: "thing",
        targetId: "t1",
        beforeState: { v: 1 } as never,
        afterState: { v: 2 } as never,
        externalTarget: "ext",
        status: "success",
        ...overrides,
      })
      .returning({ id: changelog.id });
    return row.id;
  }

  it("throws EntryNotFoundError for an unknown id", async () => {
    const registry = new ReverserRegistry();
    await expect(reverseOne(999, { registry })).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  it("throws NotReversibleError when status is not success", async () => {
    const id = await insertEntry({ status: "failed" });
    const registry = new ReverserRegistry();
    registry.register("test.op", async () => {});
    await expect(reverseOne(id, { registry })).rejects.toBeInstanceOf(NotReversibleError);
  });

  it("throws NotReversibleError when entry was already undone", async () => {
    const target = await insertEntry();
    const undoer = await insertEntry();
    await db.update(changelog).set({ undoneBy: undoer }).where(eq(changelog.id, target));
    const registry = new ReverserRegistry();
    registry.register("test.op", async () => {});
    await expect(reverseOne(target, { registry })).rejects.toBeInstanceOf(NotReversibleError);
  });

  it("inserts an undo entry, runs the reverser, and links the original", async () => {
    const id = await insertEntry();
    const seen: { operation: string }[] = [];
    const registry = new ReverserRegistry();
    registry.register("test.op", async (entry) => {
      seen.push({ operation: entry.operation });
    });

    const result = await reverseOne(id, { registry });
    expect(result.id).toBe(id);
    expect(result.reversed_by).toBeGreaterThan(id);
    expect(seen).toEqual([{ operation: "test.op" }]);

    const [original] = await db.select().from(changelog).where(eq(changelog.id, id));
    expect(original.undoneBy).toBe(result.reversed_by);

    const [undoRow] = await db
      .select()
      .from(changelog)
      .where(eq(changelog.id, result.reversed_by));
    expect(undoRow).toMatchObject({
      operation: "test.op.undo",
      status: "success",
      caller: "api:changes.undo",
      sessionId: "undo:s1",
      targetKind: "thing",
      targetId: "t1",
    });
    // The undo's before/after swap the original.
    expect(undoRow.beforeState).toEqual({ v: 2 });
    expect(undoRow.afterState).toEqual({ v: 1 });
  });

  it("marks the undo row failed and rethrows when the reverser errors", async () => {
    const id = await insertEntry();
    const registry = new ReverserRegistry();
    registry.register("test.op", async () => {
      throw new Error("reverser blew up");
    });
    await expect(reverseOne(id, { registry })).rejects.toThrow(/reverser blew up/);

    const rows = await db.select().from(changelog).orderBy(changelog.id);
    expect(rows).toHaveLength(2);
    const [original, undoRow] = rows;
    expect(original.undoneBy).toBeNull(); // not linked because reversal failed
    expect(undoRow.status).toBe("failed");
    expect(undoRow.error).toMatch(/reverser blew up/);
  });

  it("throws NoReverserError when no reverser is registered for that operation", async () => {
    const id = await insertEntry({ operation: "unknown.op" });
    const registry = new ReverserRegistry();
    await expect(reverseOne(id, { registry })).rejects.toThrow(/no reverser registered/);
  });
});
