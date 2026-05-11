import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";
import { makeRulesUiRouter } from "./routes-rules.js";

function buildApp() {
  const app = makeTestApp();
  app.use("/ui/rules", makeRulesUiRouter());
  return app;
}

async function insertRule(): Promise<number> {
  const [row] = await db
    .insert(rules)
    .values({
      domain: "email",
      name: "r",
      match: { op: "present", field: "from" } as never,
      action: { category: "noise" } as never,
      priority: 100,
      enabled: true,
      createdBy: "test",
    })
    .returning({ id: rules.id });
  return row.id;
}

describe("routes-rules", () => {
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

  describe("POST /ui/rules/:id/delete", () => {
    it("returns 400 on a non-numeric id", async () => {
      const res = await request(buildApp()).post("/ui/rules/abc/delete");
      expect(res.status).toBe(400);
    });

    it("deletes the rule and returns empty body on success", async () => {
      const id = await insertRule();
      const res = await request(buildApp()).post(`/ui/rules/${id}/delete`);
      expect(res.status).toBe(200);
      expect(res.text).toBe("");

      const remaining = await db.select().from(rules).where(eq(rules.id, id));
      expect(remaining).toEqual([]);
    });

    it("returns 404 + error markup when the id doesn't exist", async () => {
      const res = await request(buildApp()).post("/ui/rules/999/delete");
      expect(res.status).toBe(404);
      expect(res.text).toMatch(/<tr>/);
    });
  });
});
