import type { OAuth2Client } from "google-auth-library";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { needsReview, processedTransactions } from "../db/schema.js";
import { evaluate } from "../rules/engine.js";
import { classify, ClassificationParseError } from "../ai/index.js";
import { reviewAppliers } from "../needs-review/appliers.js";
import {
  readCategoriesEnum,
  readTransactionsSheet,
  type TransactionRow,
} from "../integrations/google/sheets-transactions.js";
import {
  applyTransactionCategory,
  type TransactionTarget,
} from "./transaction-actions.js";

export const TRIAGE_DOMAIN = "transaction";
export const TRIAGE_CLASSIFIER = "transaction.categorize";

/**
 * Build the AI system prompt. The category enum is read live from the sheet on
 * each cron run so adding a new row to the Categories tab is picked up
 * automatically with no code change.
 */
export function buildSystemPrompt(enumValues: string[]): string {
  const list = enumValues.map((c) => `- "${c}"`).join("\n");
  return `You categorize personal/business bank transactions for a hand-maintained budget sheet.

Choose exactly one category from this list (these are the user's canonical categories — do not invent or paraphrase):

${list}

Signals to use:
- Description and Full Description (raw merchant text)
- Amount: a leading "-" means an expense; positive means income
- Account and Institution (often hint at personal vs. business)
- Category Hint: Yodlee's coarse pre-classification — usually a good prior

If two categories seem plausible, pick the more specific one. Explain your choice in <=200 characters of reasoning. Never output a category that is not in the list above.`;
}

export type TransactionSubject = {
  transaction_id: string;
  date: string;
  description: string;
  full_description: string;
  amount: string;
  account: string;
  institution: string;
  category_hint: string;
  source: string;
};

export function buildSubject(row: TransactionRow): TransactionSubject {
  return {
    transaction_id: row.transactionId,
    date: row.date,
    description: row.description,
    full_description: row.fullDescription,
    amount: row.amount,
    account: row.account,
    institution: row.institution,
    category_hint: row.categoryHint,
    source: row.source,
  };
}

export function buildClassifierInput(row: TransactionRow): string {
  return [
    `Date: ${row.date || "(unknown)"}`,
    `Description: ${row.description || "(none)"}`,
    `Full Description: ${row.fullDescription || "(none)"}`,
    `Amount: ${row.amount || "(unknown)"}`,
    `Account: ${row.account || "(unknown)"}`,
    `Institution: ${row.institution || "(unknown)"}`,
    `Category Hint: ${row.categoryHint || "(none)"}`,
    `Source: ${row.source || "(unknown)"}`,
  ].join("\n");
}

export type TransactionProposal = {
  category: string;
  reasoning: string;
};

export type TriageOptions = {
  limit: number;
  dryRun?: boolean;
  sessionId: string;
  caller?: string;
  target: TransactionTarget;
};

export type TriageItem = {
  transaction_id: string;
  subject: TransactionSubject;
  outcome:
    | "matched_rule"
    | "queued_for_review"
    | "skipped"
    | "error"
    | "would_match"
    | "would_queue";
  rule_id?: number;
  review_id?: number;
  proposed_action?: TransactionProposal;
  ai_call_id?: number;
  error?: string;
};

export type TriageSummary = {
  total: number;
  matched: number;
  queued: number;
  skipped: number;
  errors: number;
  items: TriageItem[];
};

async function recordOutcome(values: {
  id: string;
  outcome: "matched_rule" | "needs_review" | "error";
  outcomeId?: number;
  error?: string;
}): Promise<void> {
  await db
    .insert(processedTransactions)
    .values({
      id: values.id,
      outcome: values.outcome,
      outcomeId: values.outcomeId ?? null,
      error: values.error ?? null,
    })
    .onConflictDoUpdate({
      target: processedTransactions.id,
      set: {
        outcome: values.outcome,
        outcomeId: values.outcomeId ?? null,
        error: values.error ?? null,
        lastProcessedAt: new Date(),
      },
    });
}

/**
 * Register a needs_review applier so approving a transaction review actually
 * writes the chosen category back to the source sheet.
 */
export function registerTransactionApplier(
  client: OAuth2Client,
  target: TransactionTarget,
): void {
  reviewAppliers.register("transaction", async (subjectId, decision, meta) => {
    const parsed = z
      .object({ category: z.string().min(1), reasoning: z.string().optional() })
      .parse(decision);
    return applyTransactionCategory(
      client,
      target,
      {
        transactionId: subjectId,
        category: parsed.category,
        categorizedBy: "ai:approved",
      },
      { sessionId: meta.sessionId, caller: meta.caller, intent: meta.intent },
    );
  });
}

export async function triageTransactions(
  client: OAuth2Client,
  options: TriageOptions,
): Promise<TriageSummary> {
  const caller = options.caller ?? "api:transactions.triage";
  const items: TriageItem[] = [];

  const [tab, enumValues] = await Promise.all([
    readTransactionsSheet(client, options.target.sheetId, options.target.transactionsTab),
    readCategoriesEnum(client, options.target.sheetId, options.target.categoriesTab),
  ]);

  // Build the dynamic schema once per run.
  const ProposedActionSchema = z.object({
    category: z.enum(enumValues as [string, ...string[]]),
    reasoning: z.string().min(1).max(500),
  });

  // Only process rows that are not yet categorized in the sheet.
  const candidates = tab.rows.filter((r) => !r.category || r.category.trim() === "");
  const window = candidates.slice(0, options.limit);

  for (const row of window) {
    try {
      const subject = buildSubject(row);

      const existing = await db
        .select({ id: processedTransactions.id, outcome: processedTransactions.outcome })
        .from(processedTransactions)
        .where(eq(processedTransactions.id, row.transactionId))
        .limit(1);
      if (existing.length > 0 && existing[0].outcome !== "error") {
        items.push({ transaction_id: row.transactionId, subject, outcome: "skipped" });
        continue;
      }

      const match = await evaluate(TRIAGE_DOMAIN, subject);
      if (match) {
        const proposal = ProposedActionSchema.parse(match.action);
        if (options.dryRun) {
          items.push({
            transaction_id: row.transactionId,
            subject,
            outcome: "would_match",
            rule_id: match.rule.id,
            proposed_action: proposal,
          });
          continue;
        }
        await applyTransactionCategory(
          client,
          options.target,
          {
            transactionId: row.transactionId,
            category: proposal.category,
            categorizedBy: `rule:${match.rule.id}`,
          },
          { sessionId: options.sessionId, caller, intent: `rule:${match.rule.id}` },
        );
        await recordOutcome({
          id: row.transactionId,
          outcome: "matched_rule",
          outcomeId: match.rule.id,
        });
        items.push({
          transaction_id: row.transactionId,
          subject,
          outcome: "matched_rule",
          rule_id: match.rule.id,
          proposed_action: proposal,
        });
        continue;
      }

      if (options.dryRun) {
        items.push({ transaction_id: row.transactionId, subject, outcome: "would_queue" });
        continue;
      }

      let proposed: TransactionProposal | null = null;
      let aiCallId: number | undefined;
      try {
        const result = await classify({
          classifier: TRIAGE_CLASSIFIER,
          caller,
          systemPrompt: buildSystemPrompt(enumValues),
          schema: ProposedActionSchema,
          input: buildClassifierInput(row),
        });
        proposed = result.output;
        aiCallId = result.callId;
      } catch (err) {
        const message =
          err instanceof ClassificationParseError
            ? `classifier output rejected (ai_call ${err.callId})`
            : err instanceof Error
              ? err.message
              : String(err);
        await recordOutcome({
          id: row.transactionId,
          outcome: "error",
          error: message.slice(0, 4000),
        });
        items.push({
          transaction_id: row.transactionId,
          subject,
          outcome: "error",
          error: message,
        });
        continue;
      }

      const [reviewRow] = await db
        .insert(needsReview)
        .values({
          domain: TRIAGE_DOMAIN,
          subject: subject as never,
          subjectKind: "transaction",
          subjectId: row.transactionId,
          aiCallId: aiCallId ?? null,
          proposedAction: proposed as never,
          status: "pending",
        })
        .returning({ id: needsReview.id });

      await recordOutcome({
        id: row.transactionId,
        outcome: "needs_review",
        outcomeId: reviewRow.id,
      });

      items.push({
        transaction_id: row.transactionId,
        subject,
        outcome: "queued_for_review",
        review_id: reviewRow.id,
        ai_call_id: aiCallId,
        proposed_action: proposed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await recordOutcome({
          id: row.transactionId,
          outcome: "error",
          error: message.slice(0, 4000),
        });
      } catch {
        /* swallow */
      }
      items.push({
        transaction_id: row.transactionId,
        subject: buildSubject(row),
        outcome: "error",
        error: message,
      });
    }
  }

  return {
    total: items.length,
    matched: items.filter((i) => i.outcome === "matched_rule" || i.outcome === "would_match").length,
    queued: items.filter((i) => i.outcome === "queued_for_review" || i.outcome === "would_queue").length,
    skipped: items.filter((i) => i.outcome === "skipped").length,
    errors: items.filter((i) => i.outcome === "error").length,
    items,
  };
}
