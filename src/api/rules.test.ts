import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";
import { makeRulesRouter } from "./rules.js";

function buildApp() {
  const app = makeTestApp();
  app.use("/rules", makeRulesRouter());
  return app;
}

// Each rule gets a distinct match so the (domain, match) unique index never
// rejects test fixtures. Callers can still override `match` explicitly.
let ruleSeq = 0;

async function insertRule(overrides: Partial<typeof rules.$inferInsert> = {}): Promise<number> {
  ruleSeq += 1;
  const [row] = await db
    .insert(rules)
    .values({
      domain: "email",
      name: "r",
      match: { op: "equals", field: "from", value: `sender-${ruleSeq}@example.com` } as never,
      action: { category: "noise" } as never,
      priority: 100,
      enabled: true,
      createdBy: "test",
      ...overrides,
    })
    .returning({ id: rules.id });
  return row.id;
}

describe("api/rules", () => {
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

  describe("GET /rules", () => {
    it("returns all rules with no filter", async () => {
      await insertRule({ name: "a" });
      await insertRule({ name: "b" });
      const res = await request(buildApp()).get("/rules");
      expect(res.body.count).toBe(2);
    });

    it("filters by domain and enabled", async () => {
      await insertRule({ domain: "email", enabled: true });
      await insertRule({ domain: "email", enabled: false });
      await insertRule({ domain: "transaction", enabled: true });
      const res = await request(buildApp()).get("/rules?domain=email&enabled=true");
      expect(res.body.count).toBe(1);
    });
  });

  describe("GET /rules/:id", () => {
    it("returns the rule by id", async () => {
      const id = await insertRule();
      const res = await request(buildApp()).get(`/rules/${id}`);
      expect(res.body.entry.id).toBe(id);
    });
    it("returns 404 on missing id", async () => {
      const res = await request(buildApp()).get("/rules/999");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /rules", () => {
    it("creates a new rule with valid input", async () => {
      const res = await request(buildApp())
        .post("/rules")
        .send({
          domain: "email",
          name: "my-rule",
          match: { op: "present", field: "from" },
          action: { category: "noise" },
        });
      expect(res.status).toBe(201);
      expect(res.body.entry).toMatchObject({ name: "my-rule", domain: "email", enabled: true });
    });

    it("rejects an invalid match condition shape", async () => {
      const res = await request(buildApp())
        .post("/rules")
        .send({
          domain: "email",
          name: "bad",
          match: { op: "bogus-op", field: "from" },
          action: {},
        });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /rules/:id/enable and /disable", () => {
    it("toggles the enabled flag", async () => {
      const id = await insertRule({ enabled: true });
      const disable = await request(buildApp()).post(`/rules/${id}/disable`);
      expect(disable.body.entry.enabled).toBe(false);
      const enable = await request(buildApp()).post(`/rules/${id}/enable`);
      expect(enable.body.entry.enabled).toBe(true);
    });

    it("returns 404 when toggling a missing id", async () => {
      const res = await request(buildApp()).post(`/rules/999/enable`);
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /rules/:id", () => {
    it("deletes the rule", async () => {
      const id = await insertRule();
      const res = await request(buildApp()).delete(`/rules/${id}`);
      expect(res.status).toBe(200);
      expect(await db.select().from(rules).where(eq(rules.id, id))).toEqual([]);
    });

    it("returns 404 on missing id", async () => {
      const res = await request(buildApp()).delete("/rules/999");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /rules/:id", () => {
    it("updates name + notes + priority", async () => {
      const id = await insertRule();
      const res = await request(buildApp())
        .patch(`/rules/${id}`)
        .send({ name: "renamed", notes: "n", priority: 50 });
      expect(res.body.entry).toMatchObject({ name: "renamed", notes: "n", priority: 50 });
    });

    it("rejects an empty patch body", async () => {
      const id = await insertRule();
      const res = await request(buildApp()).patch(`/rules/${id}`).send({});
      expect(res.status).toBe(400);
    });

    it("allows clearing notes by setting null", async () => {
      const id = await insertRule({ notes: "old" });
      const res = await request(buildApp()).patch(`/rules/${id}`).send({ notes: null });
      expect(res.body.entry.notes).toBeNull();
    });
  });
});
