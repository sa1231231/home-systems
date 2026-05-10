import { db } from "../db/client.js";
import { aiCalls } from "../db/schema.js";

export type AiCallRecord = {
  classifier: string;
  caller: string;
  model: string;
  systemPrompt: string;
  input: string;
  rawOutput: string;
  parsedOutput: unknown | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  effort: string;
  durationMs: number;
  status: "success" | "parse_failed" | "api_error";
  error?: string;
  intent?: string;
};

export async function recordAiCall(record: AiCallRecord): Promise<number> {
  const [row] = await db
    .insert(aiCalls)
    .values({
      classifier: record.classifier,
      caller: record.caller,
      model: record.model,
      systemPrompt: record.systemPrompt,
      input: record.input,
      rawOutput: record.rawOutput,
      parsedOutput: record.parsedOutput as never,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      effort: record.effort,
      durationMs: record.durationMs,
      status: record.status,
      error: record.error ? record.error.slice(0, 4000) : null,
      intent: record.intent ?? null,
    })
    .returning({ id: aiCalls.id });
  return row.id;
}
