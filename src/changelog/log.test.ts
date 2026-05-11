import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { logPending, markFailed, markSuccess, withChangelog } from "./log.js";

describe("changelog/log", () => {
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

  describe("logPending", () => {
    it("inserts a pending row and returns its id", async () => {
      const id = await logPending({
        caller: "test",
        sessionId: "s1",
        operation: "test.op",
        targetKind: "thing",
        targetId: "t1",
        intent: "because",
        before: { x: 1 },
        after: { x: 2 },
        externalTarget: "ext:1",
      });
      expect(id).toBeGreaterThan(0);
      const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
      expect(row).toMatchObject({
        status: "pending",
        caller: "test",
        sessionId: "s1",
        operation: "test.op",
        targetKind: "thing",
        targetId: "t1",
        intent: "because",
        externalTarget: "ext:1",
      });
      expect(row.beforeState).toEqual({ x: 1 });
      expect(row.afterState).toEqual({ x: 2 });
    });

    it("allows null intent + externalTarget", async () => {
      const id = await logPending({
        caller: "c",
        sessionId: "s",
        operation: "o",
        targetKind: "k",
        targetId: "t",
        before: {},
        after: {},
      });
      const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
      expect(row.intent).toBeNull();
      expect(row.externalTarget).toBeNull();
    });
  });

  describe("markSuccess / markFailed", () => {
    it("flips status to success", async () => {
      const id = await logPending({
        caller: "c",
        sessionId: "s",
        operation: "o",
        targetKind: "k",
        targetId: "t",
        before: {},
        after: {},
      });
      await markSuccess(id);
      const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
      expect(row.status).toBe("success");
      expect(row.error).toBeNull();
    });

    it("flips status to failed with truncated error message", async () => {
      const id = await logPending({
        caller: "c",
        sessionId: "s",
        operation: "o",
        targetKind: "k",
        targetId: "t",
        before: {},
        after: {},
      });
      const longMsg = "boom ".repeat(2000); // ~10000 chars
      await markFailed(id, new Error(longMsg));
      const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
      expect(row.status).toBe("failed");
      expect(row.error?.length).toBeLessThanOrEqual(4000);
      expect(row.error).toContain("boom");
    });

    it("stringifies non-Error values passed to markFailed", async () => {
      const id = await logPending({
        caller: "c",
        sessionId: "s",
        operation: "o",
        targetKind: "k",
        targetId: "t",
        before: {},
        after: {},
      });
      await markFailed(id, "stringly-typed");
      const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
      expect(row.status).toBe("failed");
      expect(row.error).toBe("stringly-typed");
    });
  });

  describe("withChangelog", () => {
    it("logs success and returns the inner result on success", async () => {
      const result = await withChangelog(
        {
          caller: "c",
          sessionId: "s",
          operation: "test.do",
          targetKind: "k",
          targetId: "t",
          before: { before: true },
          after: { after: true },
        },
        async () => "hello",
      );
      expect(result).toBe("hello");
      const rows = await db.select().from(changelog);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("success");
      expect(rows[0].operation).toBe("test.do");
    });

    it("logs failure and rethrows on inner error", async () => {
      await expect(
        withChangelog(
          {
            caller: "c",
            sessionId: "s",
            operation: "test.do",
            targetKind: "k",
            targetId: "t",
            before: {},
            after: {},
          },
          async () => {
            throw new Error("inner died");
          },
        ),
      ).rejects.toThrow("inner died");
      const rows = await db.select().from(changelog);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "failed" });
      expect(rows[0].error).toBe("inner died");
    });

    it("writes the pending row before the inner function executes", async () => {
      let pendingRowsDuringRun: number | null = null;
      await withChangelog(
        {
          caller: "c",
          sessionId: "s",
          operation: "test.do",
          targetKind: "k",
          targetId: "t",
          before: {},
          after: {},
        },
        async () => {
          const rows = await db.select().from(changelog);
          pendingRowsDuringRun = rows.filter((r) => r.status === "pending").length;
        },
      );
      expect(pendingRowsDuringRun).toBe(1);
    });
  });
});
