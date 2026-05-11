import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { aiCalls } from "../db/schema.js";
import { makeAiCallsRouter } from "./ai-calls.js";

function buildApp() {
  const app = makeTestApp();
  app.use("/ai-calls", makeAiCallsRouter());
  return app;
}

async function insertCall(
  overrides: Partial<typeof aiCalls.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(aiCalls)
    .values({
      classifier: "email.triage",
      caller: "test",
      model: "claude-test",
      systemPrompt: "prompt",
      input: "input",
      rawOutput: "out",
      parsedOutput: { ok: true } as never,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      effort: "low",
      durationMs: 100,
      status: "success",
      ...overrides,
    })
    .returning({ id: aiCalls.id });
  return row.id;
}

describe("api/ai-calls", () => {
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

  describe("GET /ai-calls/recent", () => {
    it("returns empty when no calls", async () => {
      const res = await request(buildApp()).get("/ai-calls/recent");
      expect(res.body).toEqual({ ok: true, count: 0, entries: [] });
    });

    it("returns rows newest-first and includes audit fields", async () => {
      await insertCall();
      await insertCall({ classifier: "tx.cat" });
      const res = await request(buildApp()).get("/ai-calls/recent");
      expect(res.body.count).toBe(2);
      expect(res.body.entries[0].classifier).toBe("tx.cat");
    });

    it("filters by classifier", async () => {
      await insertCall({ classifier: "email.triage" });
      await insertCall({ classifier: "transaction.categorize" });
      const res = await request(buildApp()).get("/ai-calls/recent?classifier=email.triage");
      expect(res.body.count).toBe(1);
    });

    it("filters by status", async () => {
      await insertCall({ status: "success" });
      await insertCall({ status: "api_error" });
      await insertCall({ status: "parse_failed" });
      const res = await request(buildApp()).get("/ai-calls/recent?status=parse_failed");
      expect(res.body.count).toBe(1);
    });

    it("rejects an invalid status filter", async () => {
      const res = await request(buildApp()).get("/ai-calls/recent?status=bogus");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /ai-calls/:id", () => {
    it("returns the call by id", async () => {
      const id = await insertCall();
      const res = await request(buildApp()).get(`/ai-calls/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.entry.id).toBe(id);
    });
    it("returns 404 on missing id", async () => {
      const res = await request(buildApp()).get("/ai-calls/999");
      expect(res.status).toBe(404);
    });
  });
});
