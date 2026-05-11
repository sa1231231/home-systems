import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { aiCalls } from "../db/schema.js";
import { recordAiCall, type AiCallRecord } from "./audit.js";

describe("recordAiCall", () => {
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

  const base: AiCallRecord = {
    classifier: "test.classify",
    caller: "test:caller",
    model: "claude-test",
    systemPrompt: "you are a test",
    input: "input text",
    rawOutput: "raw output",
    parsedOutput: { ok: true },
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 5,
    effort: "low",
    durationMs: 1234,
    status: "success",
  };

  it("inserts a row and returns the new id", async () => {
    const id = await recordAiCall(base);
    expect(id).toBeGreaterThan(0);

    const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, id));
    expect(row).toMatchObject({
      classifier: "test.classify",
      caller: "test:caller",
      model: "claude-test",
      systemPrompt: "you are a test",
      input: "input text",
      rawOutput: "raw output",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      effort: "low",
      durationMs: 1234,
      status: "success",
      error: null,
      intent: null,
    });
    expect(row.parsedOutput).toEqual({ ok: true });
  });

  it("stores parse_failed status with null parsed_output", async () => {
    const id = await recordAiCall({
      ...base,
      status: "parse_failed",
      parsedOutput: null,
      error: "schema didn't match",
    });
    const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, id));
    expect(row.status).toBe("parse_failed");
    expect(row.parsedOutput).toBeNull();
    expect(row.error).toBe("schema didn't match");
  });

  it("truncates very long error messages to 4000 chars", async () => {
    const id = await recordAiCall({
      ...base,
      status: "api_error",
      parsedOutput: null,
      error: "x".repeat(8000),
    });
    const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, id));
    expect(row.error?.length).toBe(4000);
  });

  it("persists intent when provided", async () => {
    const id = await recordAiCall({ ...base, intent: "scheduled-run" });
    const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, id));
    expect(row.intent).toBe("scheduled-run");
  });
});
