import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod/v4";
import { getAnthropicClient } from "./client.js";
import { recordAiCall, type AiCallRecord } from "./audit.js";
import { ClassificationParseError } from "./errors.js";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_EFFORT: Effort = "low";

export type Effort = "low" | "medium" | "high";

export type ClassifyOptions<T> = {
  classifier: string;
  caller: string;
  systemPrompt: string;
  schema: ZodType<T>;
  input: string;
  effort?: Effort;
  intent?: string;
  /** Optional client override for testing. */
  client?: Pick<Anthropic, "messages">;
  /** Optional max_tokens override. */
  maxTokens?: number;
};

export type ClassifyUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type ClassifyResult<T> = {
  output: T;
  callId: number;
  usage: ClassifyUsage;
};

export type ClassifyRequest = {
  model: string;
  max_tokens: number;
  system: Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }>;
  messages: Array<{ role: "user"; content: string }>;
  output_config: {
    format: ReturnType<typeof zodOutputFormat>;
    effort: Effort;
  };
};

export function buildClassifyRequest<T>(opts: ClassifyOptions<T>): ClassifyRequest {
  return {
    model: DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: opts.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: opts.input }],
    output_config: {
      format: zodOutputFormat(opts.schema as never),
      effort: opts.effort ?? DEFAULT_EFFORT,
    },
  };
}

function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export async function classify<T>(opts: ClassifyOptions<T>): Promise<ClassifyResult<T>> {
  const client = opts.client ?? getAnthropicClient();
  const request = buildClassifyRequest(opts);
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const baseRecord = {
    classifier: opts.classifier,
    caller: opts.caller,
    model: request.model,
    systemPrompt: opts.systemPrompt,
    input: opts.input,
    effort,
    intent: opts.intent,
  };

  const startedAt = Date.now();
  let response: Awaited<ReturnType<typeof client.messages.parse>>;
  try {
    response = await client.messages.parse(request as never);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const record: AiCallRecord = {
      ...baseRecord,
      rawOutput: "",
      parsedOutput: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      durationMs,
      status: "api_error",
      error: message,
    };
    await recordAiCall(record);
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  const rawOutput = extractText(response.content as never);
  const usage: ClassifyUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? 0,
  };

  const parsed = (response as { parsed_output?: T | null }).parsed_output;
  if (parsed == null) {
    const record: AiCallRecord = {
      ...baseRecord,
      rawOutput,
      parsedOutput: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadTokens,
      cacheCreationInputTokens: usage.cacheCreationTokens,
      durationMs,
      status: "parse_failed",
      error: "model output did not match schema",
    };
    const callId = await recordAiCall(record);
    throw new ClassificationParseError(opts.classifier, callId, rawOutput);
  }

  const record: AiCallRecord = {
    ...baseRecord,
    rawOutput,
    parsedOutput: parsed,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadTokens,
    cacheCreationInputTokens: usage.cacheCreationTokens,
    durationMs,
    status: "success",
  };
  const callId = await recordAiCall(record);
  return { output: parsed, callId, usage };
}
