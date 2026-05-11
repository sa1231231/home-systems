import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { clearReversers } from "../../tests/helpers/registry.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { registry } from "../changelog/reversers.js";
import { makeChangesRouter, windowStartFor24h } from "./changes.js";

describe("windowStartFor24h", () => {
  it("returns now minus 24 hours", () => {
    const now = new Date(Date.UTC(2026, 4, 11, 12, 0, 0));
    expect(windowStartFor24h(now).toISOString()).toBe("2026-05-10T12:00:00.000Z");
  });

  it("crosses month boundaries", () => {
    const now = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
    expect(windowStartFor24h(now).toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("crosses year boundaries", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(windowStartFor24h(now).toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });

  it("defaults to current time when no argument is passed", () => {
    const before = Date.now();
    const start = windowStartFor24h().getTime();
    const after = Date.now();
    expect(start).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(start).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);
  });
});

function buildApp() {
  const app = makeTestApp();
  app.use("/changes", makeChangesRouter());
  return app;
}

async function insertChangelog(
  overrides: Partial<typeof changelog.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(changelog)
    .values({
      caller: "test",
      sessionId: "session-a",
      operation: "test.op",
      targetKind: "thing",
      targetId: "t1",
      beforeState: { v: 1 } as never,
      afterState: { v: 2 } as never,
      status: "success",
      ...overrides,
    })
    .returning({ id: changelog.id });
  return row.id;
}

describe("api/changes routes", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    clearReversers();
  });

  describe("GET /changes/recent", () => {
    it("returns an empty list when changelog is empty", async () => {
      const res = await request(buildApp()).get("/changes/recent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, count: 0, entries: [] });
    });

    it("returns rows in desc id order, capped at limit", async () => {
      await insertChangelog();
      const id2 = await insertChangelog();
      const id3 = await insertChangelog();
      const res = await request(buildApp()).get("/changes/recent?limit=2");
      expect(res.body.count).toBe(2);
      expect(res.body.entries.map((e: { id: number }) => e.id)).toEqual([id3, id2]);
    });

    it("rejects an out-of-range limit", async () => {
      const res = await request(buildApp()).get("/changes/recent?limit=99999");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /changes/recent24h", () => {
    it("returns rolling 24h window with since timestamp", async () => {
      await insertChangelog();
      const res = await request(buildApp()).get("/changes/recent24h");
      expect(res.status).toBe(200);
      expect(res.body.since).toMatch(/T/);
      expect(res.body.count).toBe(1);
    });
  });

  describe("GET /changes/session/:sessionId", () => {
    it("returns entries for a specific session in asc id order", async () => {
      const id1 = await insertChangelog({ sessionId: "session-x" });
      const id2 = await insertChangelog({ sessionId: "session-x" });
      await insertChangelog({ sessionId: "other" });
      const res = await request(buildApp()).get("/changes/session/session-x");
      expect(res.body.entries.map((e: { id: number }) => e.id)).toEqual([id1, id2]);
    });
  });

  describe("POST /changes/undo/:id", () => {
    it("returns 404 when id doesn't exist", async () => {
      const res = await request(buildApp()).post("/changes/undo/999");
      expect(res.status).toBe(404);
    });

    it("returns 409 when no reverser is registered", async () => {
      const id = await insertChangelog({ operation: "no-reverser" });
      const res = await request(buildApp()).post(`/changes/undo/${id}`);
      expect(res.status).toBe(409);
    });

    it("reverses successfully and returns reversed_by", async () => {
      registry.register("test.op", async () => {});
      const id = await insertChangelog();
      const res = await request(buildApp()).post(`/changes/undo/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.reversed_by).toBeGreaterThan(id);
    });
  });

  describe("POST /changes/undo-last-n", () => {
    it("rejects an empty body", async () => {
      const res = await request(buildApp()).post("/changes/undo-last-n").send({});
      expect(res.status).toBe(400);
    });

    it("reverses up to n entries for the given operation, newest first", async () => {
      registry.register("test.op", async () => {});
      await insertChangelog();
      const id2 = await insertChangelog();
      const id3 = await insertChangelog();
      const res = await request(buildApp())
        .post("/changes/undo-last-n")
        .send({ operation: "test.op", n: 2 });
      expect(res.body.reversed).toEqual([id3, id2]);
    });

    it("collects failures without aborting", async () => {
      let n = 0;
      registry.register("test.op", async () => {
        n++;
        if (n === 1) throw new Error("first failed");
      });
      await insertChangelog();
      await insertChangelog();
      const res = await request(buildApp())
        .post("/changes/undo-last-n")
        .send({ operation: "test.op", n: 2 });
      expect(res.body.ok).toBe(false);
      expect(res.body.failures).toHaveLength(1);
      expect(res.body.reversed).toHaveLength(1);
    });
  });

  describe("POST /changes/rollback-session/:sessionId", () => {
    it("reverses every success row in the session, newest first", async () => {
      registry.register("test.op", async () => {});
      const id1 = await insertChangelog({ sessionId: "rb" });
      const id2 = await insertChangelog({ sessionId: "rb" });
      const res = await request(buildApp()).post("/changes/rollback-session/rb");
      expect(res.body.reversed).toEqual([id2, id1]);
    });

    it("skips entries that are already undone or not-success", async () => {
      registry.register("test.op", async () => {});
      await insertChangelog({ sessionId: "rb", status: "failed" });
      await insertChangelog({ sessionId: "rb" });
      const res = await request(buildApp()).post("/changes/rollback-session/rb");
      // Only the success row should be reversed.
      expect(res.body.reversed).toHaveLength(1);
    });
  });
});
