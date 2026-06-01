import { z } from "zod/v4";
import { classify, type ClassifyResult } from "./classify.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { Cond } from "../rules/dsl.js";

export const SYNTHESIZE_CLASSIFIER = "email.synthesize_rule";

export const SynthLeafField = z.enum(["from", "to", "subject", "snippet", "account"]);
export const SynthLeafOp = z.enum(["equals", "contains", "starts_with", "ends_with", "regex"]);

export const SynthLeafSchema = z.object({
  field: SynthLeafField,
  op: SynthLeafOp,
  value: z.string().min(1),
});

export const SynthMatchSchema = z.union([
  SynthLeafSchema,
  z.object({ all: z.array(SynthLeafSchema).min(2).max(5) }),
]);

export const SynthOutputSchema = z.object({
  category: z.enum(["noise", "worth_reading", "needs_reply"]),
  match: SynthMatchSchema,
  reasoning: z.string().min(1).max(200),
});

export type SynthOutput = z.infer<typeof SynthOutputSchema>;
export type SynthMatch = z.infer<typeof SynthMatchSchema>;

const SYSTEM_PROMPT = `You synthesize Gmail triage rules from user corrections.

The user has marked an email as wrongly classified and given a free-text reason. Produce an exception rule that:

1. Matches the wrongly-classified email AND any future email the user would also want classified this way — no more, no less.
2. Combines two or more signals with "all" when one signal alone would over-match (e.g., a from-address that also fires the wrong rule). Single-leaf matches are only correct when one signal alone uniquely identifies the right bucket.
3. Uses lowercase substrings for "contains" — operators are case-insensitive at match time.
4. Never produces a match broader than the rule it is correcting (you are given that rule when it exists).
5. Picks the category that matches the user's reason: "noise" (auto-archive), "worth_reading" (informational), "needs_reply" (action required).

Output JSON only, per the schema. Reasoning is one short sentence the user will see next to the rule.`;

export type SynthesizeRuleInput = {
  /** Email metadata captured by triage. */
  email: {
    account: string;
    from: string | null;
    to: string | null;
    subject: string | null;
    snippet: string;
    labels: string[];
  };
  /** What fired today + why we think it was wrong. */
  current: {
    category: "noise" | "worth_reading" | "needs_reply";
    source: "rule" | "llm";
    firedRuleName?: string;
    firedMatch?: Cond;
  };
  /** Free-text reason the user typed. */
  reason: string;
  caller: string;
  intent?: string;
  client?: Pick<Anthropic, "messages">;
};

export function buildUserMessage(input: SynthesizeRuleInput): string {
  const lines: string[] = [
    "EMAIL",
    `From: ${input.email.from ?? "(unknown)"}`,
    `To: ${input.email.to ?? "(unknown)"}`,
    `Subject: ${input.email.subject ?? "(none)"}`,
    `Labels: ${input.email.labels.join(", ") || "(none)"}`,
    `Account: ${input.email.account || "(unscoped)"}`,
    `Snippet: ${input.email.snippet}`,
    "",
    "CURRENT CLASSIFICATION",
    `Category: ${input.current.category}`,
    `Source: ${input.current.source}`,
  ];
  if (input.current.firedRuleName) {
    lines.push(`Fired rule: ${input.current.firedRuleName}`);
  }
  if (input.current.firedMatch) {
    lines.push(`Fired match: ${JSON.stringify(input.current.firedMatch)}`);
  }
  lines.push("", "USER REASON", input.reason);
  return lines.join("\n");
}

export async function synthesizeRule(
  input: SynthesizeRuleInput,
): Promise<ClassifyResult<SynthOutput>> {
  return classify({
    classifier: SYNTHESIZE_CLASSIFIER,
    caller: input.caller,
    systemPrompt: SYSTEM_PROMPT,
    schema: SynthOutputSchema,
    input: buildUserMessage(input),
    intent: input.intent,
    client: input.client,
  });
}
