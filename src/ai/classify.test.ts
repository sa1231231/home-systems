import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

const { recordAiCall } = vi.hoisted(() => ({ recordAiCall: vi.fn(async () => 999) }));
vi.mock("./audit.js", () => ({ recordAiCall }));

import { buildClassifyRequest, classify, DEFAULT_EFFORT, DEFAULT_MODEL } from "./classify.js";
import { ClassificationParseError } from "./errors.js";

const Schema = z.object({ sentiment: z.enum(["positive", "neutral", "negative"]) });

beforeEach(() => {
  recordAiCall.mockClear();
});

function fakeUsage(overrides: Record<string, number> = {}) {
  return {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...overrides,
  };
}

function fakeClient(response: unknown) {
  return {
    messages: {
      parse: vi.fn(async () => response),
    },
  } as never;
}

describe("buildClassifyRequest", () => {
  it("uses Opus 4.7, low effort, cache-controlled system block, no thinking/sampling params", () => {
    const req = buildClassifyRequest({
      classifier: "test.x",
      caller: "unit",
      systemPrompt: "Classify the sentiment.",
      schema: Schema,
      input: "I love it.",
    });
    expect(req.model).toBe(DEFAULT_MODEL);
    expect(req.model).toBe("claude-opus-4-7");
    expect(req.system).toEqual([
      { type: "text", text: "Classify the sentiment.", cache_control: { type: "ephemeral" } },
    ]);
    expect(req.messages).toEqual([{ role: "user", content: "I love it." }]);
    expect(req.output_config.effort).toBe(DEFAULT_EFFORT);
    expect(req.output_config.effort).toBe("low");
    expect(req.output_config.format).toBeDefined();
    expect(req).not.toHaveProperty("thinking");
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("top_p");
    expect(req).not.toHaveProperty("top_k");
  });

  it("respects an explicit effort override", () => {
    const req = buildClassifyRequest({
      classifier: "test.x",
      caller: "unit",
      systemPrompt: "p",
      schema: Schema,
      input: "i",
      effort: "high",
    });
    expect(req.output_config.effort).toBe("high");
  });
});

describe("classify — success path", () => {
  it("returns parsed output and persists a success row with the right usage", async () => {
    const client = fakeClient({
      content: [{ type: "text", text: '{"sentiment":"positive"}' }],
      usage: fakeUsage({ cache_read_input_tokens: 50 }),
      parsed_output: { sentiment: "positive" },
    });

    const result = await classify({
      classifier: "smoke.sentiment",
      caller: "unit",
      systemPrompt: "Classify.",
      schema: Schema,
      input: "great day",
      client,
    });

    expect(result.output).toEqual({ sentiment: "positive" });
    expect(result.callId).toBe(999);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
    });
    expect(recordAiCall).toHaveBeenCalledOnce();
    const arg = recordAiCall.mock.calls[0][0];
    expect(arg.status).toBe("success");
    expect(arg.parsedOutput).toEqual({ sentiment: "positive" });
    expect(arg.rawOutput).toBe('{"sentiment":"positive"}');
    expect(arg.cacheReadInputTokens).toBe(50);
    expect(arg.effort).toBe("low");
    expect(arg.model).toBe("claude-opus-4-7");
    expect(arg.error).toBeUndefined();
  });
});

describe("classify — parse failure", () => {
  it("throws ClassificationParseError and persists a parse_failed row", async () => {
    const client = fakeClient({
      content: [{ type: "text", text: "not json" }],
      usage: fakeUsage(),
      parsed_output: null,
    });

    await expect(
      classify({
        classifier: "smoke.sentiment",
        caller: "unit",
        systemPrompt: "Classify.",
        schema: Schema,
        input: "x",
        client,
      }),
    ).rejects.toBeInstanceOf(ClassificationParseError);

    expect(recordAiCall).toHaveBeenCalledOnce();
    const arg = recordAiCall.mock.calls[0][0];
    expect(arg.status).toBe("parse_failed");
    expect(arg.parsedOutput).toBeNull();
    expect(arg.rawOutput).toBe("not json");
    expect(arg.error).toMatch(/did not match/i);
  });
});

describe("classify — api error", () => {
  it("rethrows the underlying error and persists an api_error row", async () => {
    const client = {
      messages: {
        parse: vi.fn(async () => {
          throw new Error("rate limited");
        }),
      },
    } as never;

    await expect(
      classify({
        classifier: "smoke.sentiment",
        caller: "unit",
        systemPrompt: "Classify.",
        schema: Schema,
        input: "x",
        client,
      }),
    ).rejects.toThrow(/rate limited/);

    expect(recordAiCall).toHaveBeenCalledOnce();
    const arg = recordAiCall.mock.calls[0][0];
    expect(arg.status).toBe("api_error");
    expect(arg.parsedOutput).toBeNull();
    expect(arg.rawOutput).toBe("");
    expect(arg.error).toMatch(/rate limited/);
    expect(arg.inputTokens).toBe(0);
  });
});
