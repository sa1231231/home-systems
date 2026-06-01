import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordAiCall } = vi.hoisted(() => ({ recordAiCall: vi.fn(async () => 777) }));
vi.mock("./audit.js", () => ({ recordAiCall }));

import {
  buildUserMessage,
  synthesizeRule,
  SynthMatchSchema,
  SynthOutputSchema,
  SYNTHESIZE_CLASSIFIER,
} from "./synthesize-rule.js";

beforeEach(() => {
  recordAiCall.mockClear();
});

function fakeClient(parsed: unknown) {
  return {
    messages: {
      parse: vi.fn(async () => ({
        content: [{ type: "text", text: JSON.stringify(parsed) }],
        usage: {
          input_tokens: 50,
          output_tokens: 30,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        parsed_output: parsed,
      })),
    },
  } as never;
}

describe("SynthMatchSchema", () => {
  it("accepts a single leaf", () => {
    expect(
      SynthMatchSchema.safeParse({ field: "from", op: "contains", value: "amex" }).success,
    ).toBe(true);
  });

  it("accepts an 'all' of 2+ leaves", () => {
    const parsed = SynthMatchSchema.safeParse({
      all: [
        { field: "from", op: "contains", value: "americanexpress" },
        { field: "subject", op: "contains", value: "on the way" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects 'all' with only one leaf (use a single leaf instead)", () => {
    const parsed = SynthMatchSchema.safeParse({
      all: [{ field: "from", op: "contains", value: "amex" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unsafe operators (present/absent are not in the enum)", () => {
    const parsed = SynthMatchSchema.safeParse({ field: "from", op: "present" });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const parsed = SynthMatchSchema.safeParse({ field: "body", op: "contains", value: "x" });
    expect(parsed.success).toBe(false);
  });
});

describe("SynthOutputSchema", () => {
  it("requires category + match + short reasoning", () => {
    const ok = SynthOutputSchema.safeParse({
      category: "worth_reading",
      match: { field: "subject", op: "contains", value: "on the way" },
      reasoning: "Delivery updates are not promotional noise.",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects reasoning over 200 chars", () => {
    const ok = SynthOutputSchema.safeParse({
      category: "noise",
      match: { field: "from", op: "contains", value: "x" },
      reasoning: "x".repeat(201),
    });
    expect(ok.success).toBe(false);
  });
});

describe("buildUserMessage", () => {
  it("includes email fields, current classification, fired rule, and reason", () => {
    const out = buildUserMessage({
      email: {
        account: "me@example.com",
        from: "Amex <noreply@americanexpress.com>",
        to: "me@example.com",
        subject: "Your car is on the way",
        snippet: "Driver Mike will arrive in 10 minutes.",
        labels: ["INBOX", "Noise"],
      },
      current: {
        category: "noise",
        source: "rule",
        firedRuleName: "Amex notifications",
        firedMatch: { field: "from", op: "contains", value: "americanexpress.com" },
      },
      reason: "This is a delivery update from Amex about my car, not a promo.",
      caller: "ui:gmail.correct",
    });
    expect(out).toContain("From: Amex <noreply@americanexpress.com>");
    expect(out).toContain("Subject: Your car is on the way");
    expect(out).toContain("Category: noise");
    expect(out).toContain("Source: rule");
    expect(out).toContain("Fired rule: Amex notifications");
    expect(out).toContain("Fired match:");
    expect(out).toContain("USER REASON");
    expect(out).toContain("delivery update");
  });

  it("omits fired rule/match lines when the source is LLM (no rule yet)", () => {
    const out = buildUserMessage({
      email: {
        account: "",
        from: "x@y.com",
        to: null,
        subject: "Hello",
        snippet: "...",
        labels: [],
      },
      current: { category: "worth_reading", source: "llm" },
      reason: "noise",
      caller: "ui",
    });
    expect(out).not.toContain("Fired rule:");
    expect(out).not.toContain("Fired match:");
    expect(out).toContain("Source: llm");
  });
});

describe("synthesizeRule (integration)", () => {
  it("calls classify with the synthesize classifier and returns the parsed output", async () => {
    const parsed = {
      category: "worth_reading",
      match: {
        all: [
          { field: "from", op: "contains", value: "americanexpress" },
          { field: "subject", op: "contains", value: "on the way" },
        ],
      },
      reasoning: "Delivery updates are worth reading, not noise.",
    };
    const client = fakeClient(parsed);

    const result = await synthesizeRule({
      email: {
        account: "me@example.com",
        from: "amex@x.com",
        to: "me@example.com",
        subject: "Your car is on the way",
        snippet: "...",
        labels: [],
      },
      current: { category: "noise", source: "rule", firedRuleName: "Amex" },
      reason: "delivery update",
      caller: "test",
      client,
    });

    expect(result.output).toEqual(parsed);
    expect(recordAiCall).toHaveBeenCalledOnce();
    const arg = recordAiCall.mock.calls[0][0];
    expect(arg.classifier).toBe(SYNTHESIZE_CLASSIFIER);
    expect(arg.status).toBe("success");
  });
});
