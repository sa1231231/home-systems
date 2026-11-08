import type { OAuth2Client } from "google-auth-library";
import { z } from "zod/v4";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { processedTransactions } from "../db/schema.js";
import { evaluate, isSituational } from "../rules/engine.js";
import {
  appendAutoCatRules,
  autoCatExistingKeys,
  autoCatRuleKey,
  AUTOCAT_DEFAULT_TAB,
  matchAutoCat,
  readAutoCat,
  type AutoCatCandidate,
  type AutoCatTab,
} from "./transaction-autocat.js";
import { classify, ClassificationParseError, MissingAnthropicKeyError } from "../ai/index.js";
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

If two categories seem plausible, pick the more specific one. Explain your choice in <=200 characters of reasoning. Never output a category that is not in the list above.`;
}

// Subject keys here are the fields the rules engine can match on. We
// intentionally exclude Tiller-owned columns (Category Hint, Source,
// Categorized By, Categorized Date) so rules and AI classifications only
// reason about merchant-identifying data, not Tiller's pre-classification.
export type TransactionSubject = {
  transaction_id: string;
  date: string;
  description: string;
  full_description: string;
  amount: string;
  account: string;
  institution: string;
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
  outcome: "matched_rule" | "ai_applied" | "skipped" | "error" | "would_match" | "would_queue";
  rule_id?: number;
  review_id?: number;
  proposed_action?: TransactionProposal;
  ai_call_id?: number;
  error?: string;
};

export type TriageSummary = {
  total: number;
  matched: number;
  /** Rows the AI categorized and applied directly. */
  applied: number;
  queued: number;
  skipped: number;
  errors: number;
  items: TriageItem[];
};

async function recordOutcome(values: {
  id: string;
  outcome: "matched_rule" | "ai_applied" | "error";
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

  // Candidates = rows with no Category yet in the sheet AND not already
  // recorded in processed_transactions with a non-error outcome. Filter out
  // already-processed rows BEFORE applying the limit; otherwise the limit
  // gets wasted on rows that would immediately fall through to the per-row
  // "skipped" branch and every run after the first does ~zero new work.
  const sheetCandidates = tab.rows.filter((r) => !r.category || r.category.trim() === "");
  const alreadyDone = new Set<string>();
  if (sheetCandidates.length > 0) {
    const candidateIds = sheetCandidates.map((r) => r.transactionId);
    const seen = await db
      .select({ id: processedTransactions.id })
      .from(processedTransactions)
      .where(
        and(
          inArray(processedTransactions.id, candidateIds),
          ne(processedTransactions.outcome, "error"),
        ),
      );
    for (const r of seen) alreadyDone.add(r.id);
  }
  // Surface the already-done rows in the summary so callers can see why work
  // didn't happen ("total was 50, 49 skipped because already processed").
  for (const r of sheetCandidates) {
    if (alreadyDone.has(r.transactionId)) {
      items.push({
        transaction_id: r.transactionId,
        subject: buildSubject(r),
        outcome: "skipped",
      });
    }
  }
  const candidates = sheetCandidates.filter((r) => !alreadyDone.has(r.transactionId));
  const window = candidates.slice(0, options.limit);

  // Rule source: Tiller's AutoCat tab (the consolidated store). Tiller applies
  // it on fill; we also match here so a merchant taught earlier in this same run
  // doesn't get re-sent to the AI. Loaded once per run. resolveMatch keeps a
  // DB-rule fallback for when AutoCat can't be read, but the transaction-domain
  // `rules` rows were migrated into AutoCat and cleared, so in prod AutoCat is
  // effectively the only source (the fallback is vestigial, exercised by tests).
  let autocat: AutoCatTab | null = null;
  try {
    autocat = await readAutoCat(
      client,
      options.target.sheetId,
      options.target.autoCatTab ?? AUTOCAT_DEFAULT_TAB,
    );
  } catch {
    autocat = null;
  }
  const useAutoCat = autocat !== null && autocat.headers.length > 0;

  // Auto-teach state: new AutoCat rules learned from AI categorizations this
  // run. Deduped against what's already in the tab and against each other.
  const existingAutoCatKeys =
    useAutoCat && autocat ? autoCatExistingKeys(autocat.raw) : new Set<string>();
  const taughtKeys = new Set<string>();
  const taughtCandidates: AutoCatCandidate[] = [];

  type ResolvedMatch = { ruleId: number | null; ruleLabel: string; action: unknown };
  const resolveMatch = async (subj: TransactionSubject): Promise<ResolvedMatch | null> => {
    if (useAutoCat && autocat) {
      const category = matchAutoCat(autocat.rules, subj);
      return category
        ? { ruleId: null, ruleLabel: "autocat", action: { category, reasoning: "AutoCat rule" } }
        : null;
    }
    const m = await evaluate(TRIAGE_DOMAIN, subj);
    return m ? { ruleId: m.rule.id, ruleLabel: `rule:${m.rule.id}`, action: m.action } : null;
  };

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

      // A situational rule (action `{situational:true}`) matches first by
      // priority but is not a category rule — skip it so the row falls
      // through to AI review every time.
      const match = await resolveMatch(subject);
      if (match && !isSituational(match.action)) {
        const proposal = ProposedActionSchema.parse(match.action);
        if (options.dryRun) {
          items.push({
            transaction_id: row.transactionId,
            subject,
            outcome: "would_match",
            rule_id: match.ruleId ?? undefined,
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
            categorizedBy: match.ruleLabel,
          },
          { sessionId: options.sessionId, caller, intent: match.ruleLabel },
        );
        await recordOutcome({
          id: row.transactionId,
          outcome: "matched_rule",
          outcomeId: match.ruleId ?? undefined,
        });
        items.push({
          transaction_id: row.transactionId,
          subject,
          outcome: "matched_rule",
          rule_id: match.ruleId ?? undefined,
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
        // Configuration-level failure (no API key) — abort the whole run so
        // we don't grind through N identical errors. The route will surface
        // a single clear banner.
        if (err instanceof MissingAnthropicKeyError) {
          throw err;
        }
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

      // Auto-apply the AI category and teach AutoCat so Tiller handles this
      // merchant automatically next time. The AutoCat + Transactions tabs are
      // the review surface; the changelog/undo covers any corrections.
      await applyTransactionCategory(
        client,
        options.target,
        {
          transactionId: row.transactionId,
          category: proposed.category,
          categorizedBy: "ai",
        },
        { sessionId: options.sessionId, caller, intent: "ai" },
      );

      if (useAutoCat && autocat) {
        const token = row.description.trim() || row.fullDescription.trim();
        if (token) {
          const candidate: AutoCatCandidate = {
            descriptionContains: token,
            category: proposed.category,
          };
          const key = autoCatRuleKey(candidate);
          if (!taughtKeys.has(key) && !existingAutoCatKeys.has(key)) {
            taughtKeys.add(key);
            taughtCandidates.push(candidate);
            // In-run learning: later rows of the same merchant match in memory
            // without another AI call (Tiller re-applies on its next fill).
            autocat.rules.push({
              descriptionContains: token,
              category: proposed.category,
              rowNumber: -1,
            });
          }
        }
      }

      await recordOutcome({
        id: row.transactionId,
        outcome: "ai_applied",
        outcomeId: aiCallId ?? undefined,
      });

      items.push({
        transaction_id: row.transactionId,
        subject,
        outcome: "ai_applied",
        ai_call_id: aiCallId,
        proposed_action: proposed,
      });
    } catch (err) {
      // Don't trap configuration-level failures in the per-row catch — let
      // them abort the whole run.
      if (err instanceof MissingAnthropicKeyError) {
        throw err;
      }
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

  // Teaching is best-effort and batched: the categories were already applied
  // row-by-row, so a failed append here just means Tiller relearns next run.
  if (!options.dryRun && useAutoCat && autocat && taughtCandidates.length > 0) {
    try {
      await appendAutoCatRules(
        client,
        options.target.sheetId,
        options.target.autoCatTab ?? AUTOCAT_DEFAULT_TAB,
        autocat.headers,
        taughtCandidates,
      );
    } catch (err) {
      console.error(
        `[triage] AutoCat teach append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    total: items.length,
    matched: items.filter((i) => i.outcome === "matched_rule" || i.outcome === "would_match").length,
    applied: items.filter((i) => i.outcome === "ai_applied").length,
    queued: items.filter((i) => i.outcome === "would_queue").length,
    skipped: items.filter((i) => i.outcome === "skipped").length,
    errors: items.filter((i) => i.outcome === "error").length,
    items,
  };
}
