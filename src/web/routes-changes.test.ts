import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { clearReversers } from "../../tests/helpers/registry.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { makeChangesUiRouter } from "./routes-changes.js";
import { registry } from "../changelog/reversers.js";

function buildApp() {
  const app = makeTestApp();
  mountViews(app);
  app.use("/ui/changes", makeChangesUiRouter());
  return app;
}

async function insertChangelog(
  overrides: Partial<typeof changelog.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(changelog)
    .values({
      caller: "test",
      sessionId: "s",
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

describe("routes-changes", () => {
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

  describe("GET /ui/changes", () => {
    it("renders the page with no rows on empty changelog", async () => {
      const res = await request(buildApp()).get("/ui/changes/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/html/);
    });

    it("renders recent changelog rows", async () => {
      await insertChangelog({ operation: "marker.op", targetId: "mark-1" });
      const res = await request(buildApp()).get("/ui/changes/");
      expect(res.text).toContain("marker.op");
      expect(res.text).toContain("mark-1");
    });
  });

  describe("POST /ui/changes/:id/undo", () => {
    it("returns 400 on an invalid id", async () => {
      const res = await request(buildApp()).post("/ui/changes/not-a-number/undo");
      expect(res.status).toBe(400);
    });

    it("returns 404 when no changelog row matches", async () => {
      const res = await request(buildApp()).post("/ui/changes/999/undo");
      expect(res.status).toBe(404);
    });

    it("returns 409 when no reverser is registered for the op", async () => {
      const id = await insertChangelog({ operation: "novel.op" });
      const res = await request(buildApp()).post(`/ui/changes/${id}/undo`);
      expect(res.status).toBe(409);
      expect(res.text).toMatch(/no reverser/i);
    });

    it("reverses successfully and renders the updated row when reverser succeeds", async () => {
      let reverserCalled = false;
      registry.register("test.op", async () => {
        reverserCalled = true;
      });
      const id = await insertChangelog();
      const res = await request(buildApp()).post(`/ui/changes/${id}/undo`);
      expect(res.status).toBe(200);
      expect(reverserCalled).toBe(true);

      const [row] = await db.select().from(changelog).where(eq(changelog.id, id));
      expect(row.undoneBy).toBeGreaterThan(id);
    });

    it("returns 500 with the inner error when the reverser throws", async () => {
      registry.register("test.op", async () => {
        throw new Error("reverser fail");
      });
      const id = await insertChangelog();
      const res = await request(buildApp()).post(`/ui/changes/${id}/undo`);
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/reverser fail/);
    });
  });
});
