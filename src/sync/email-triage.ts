import type { OAuth2Client } from "google-auth-library";
import { z } from "zod/v4";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { needsReview, processedEmails } from "../db/schema.js";
import { evaluate } from "../rules/engine.js";
import { classify, ClassificationParseError, MissingAnthropicKeyError } from "../ai/index.js";
import { getMessageMetadata, listTriageInbox, type GmailMetadata } from "../integrations/google/gmail.js";
import {
  getOAuthClient,
  getTriageAccounts,
  resolveClientForAccount,
} from "../integrations/google/oauth.js";
import { applyEmailAction, type EmailAction } from "./email-actions.js";
import { reviewAppliers } from "../needs-review/appliers.js";

/** A db handle or an open transaction — both expose the query builder we need. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TRIAGE_DOMAIN = "email";
export const TRIAGE_CLASSIFIER = "email.triage";

const SYSTEM_PROMPT = `You triage emails for a personal inbox. Classify each email as exactly one of three categories:

- "noise" — newsletters, marketing, automated notifications, receipts, social, anything the user does not need to read or act on. These are labeled "Noise".
- "worth_reading" — informational but useful: substantive updates, threads worth glancing at, FYI items. These are labeled "Worth Reading".
- "needs_reply" — requires a human response, action item, scheduling, or a personal message from someone the user knows. These are labeled "Needs Reply".

Nothing is archived, starred, or deleted — only labels are added. Always provide concise reasoning under 200 characters explaining why this email fits the chosen category.`;

export const TriageCategory = z.enum(["noise", "worth_reading", "needs_reply"]);
export type TriageCategoryT = z.infer<typeof TriageCategory>;

export const ProposedActionSchema = z.object({
  category: TriageCategory,
  reasoning: z.string().min(1).max(500),
});

export type TriageProposal = z.infer<typeof ProposedActionSchema>;

/**
 * Register a needs_review applier so approving an email-domain review actually
 * runs the proposed action against the source message in Gmail.
 */
export function registerEmailApplier(): void {
  reviewAppliers.register("email", async (subjectId, decision, meta) => {
    const proposal = ProposedActionSchema.parse(decision);
    const action = mapCategoryToAction(proposal);
    // Apply against the Gmail account the reviewed message belongs to.
    const client = meta.account
      ? await resolveClientForAccount(meta.account)
      : getOAuthClient();
    return applyEmailAction(client, subjectId, action, meta);
  });
}

/**
 * Map a triage category to the Gmail label change it represents. Deterministic
 * — the same category always produces the same action. This is what gets
 * applied for both rule matches and (eventually) approved AI proposals.
 */
export function mapCategoryToAction(proposal: TriageProposal): EmailAction {
  switch (proposal.category) {
    case "noise":
      return { add_labels: ["Noise"], remove_labels: [], reasoning: proposal.reasoning };
    case "worth_reading":
      return {
        add_labels: ["Worth Reading"],
        remove_labels: [],
        reasoning: proposal.reasoning,
      };
    case "needs_reply":
      return {
        add_labels: ["Needs Reply"],
        remove_labels: [],
        reasoning: proposal.reasoning,
      };
  }
}

export type EmailSubject = {
  /** Gmail account the message belongs to — scopes rules per account. */
  account: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string;
  labels: string[];
  received_at: string | null;
};

export type TriageOptions = {
  dryRun?: boolean;
  sessionId: string;
  caller?: string;
};

export type TriageItem = {
  gmail_id: string;
  thread_id: string;
  subject: EmailSubject;
  outcome: "matched_rule" | "queued_for_review" | "skipped" | "error" | "would_match" | "would_queue";
  rule_id?: number;
  review_id?: number;
  proposed_action?: TriageProposal;
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

export type AccountTriageCounts = {
  account: string;
  total: number;
  matched: number;
  queued: number;
  skipped: number;
  errors: number;
};

export type TriageAllSummary = TriageSummary & {
  /** Per-account breakdown across every triaged Gmail account. */
  accounts: AccountTriageCounts[];
};

export function buildSubject(metadata: GmailMetadata, account: string): EmailSubject {
  return {
    account,
    from: metadata.from,
    to: metadata.to,
    subject: metadata.subject,
    snippet: metadata.snippet,
    labels: metadata.labelIds,
    received_at: metadata.receivedAt ? metadata.receivedAt.toISOString() : null,
  };
}

export function buildClassifierInput(metadata: GmailMetadata): string {
  const lines = [
    `From: ${metadata.from ?? "(unknown)"}`,
    `To: ${metadata.to ?? "(unknown)"}`,
    `Subject: ${metadata.subject ?? "(none)"}`,
    `Labels: ${metadata.labelIds.join(", ") || "(none)"}`,
    `Snippet: ${metadata.snippet}`,
  ];
  return lines.join("\n");
}

async function recordOutcome(
  executor: DbOrTx,
  values: {
    id: string;
    account: string;
    threadId: string;
    outcome: "matched_rule" | "needs_review" | "error";
    outcomeId?: number;
    error?: string;
    emailMeta?: EmailSubject;
  },
): Promise<void> {
  await executor
    .insert(processedEmails)
    .values({
      id: values.id,
      account: values.account,
      threadId: values.threadId,
      outcome: values.outcome,
      outcomeId: values.outcomeId ?? null,
      error: values.error ?? null,
      emailMeta: (values.emailMeta ?? null) as never,
    })
    .onConflictDoUpdate({
      target: [processedEmails.account, processedEmails.id],
      set: {
        outcome: values.outcome,
        outcomeId: values.outcomeId ?? null,
        error: values.error ?? null,
        lastProcessedAt: new Date(),
        // Only overwrite emailMeta when this run actually captured fresh
        // metadata (rule-fired or needs_review paths); error retries that
        // never re-fetched should keep the previous snapshot.
        ...(values.emailMeta ? { emailMeta: values.emailMeta as never } : {}),
      },
    });
}

export async function triageEmails(
  client: OAuth2Client,
  account: string,
  options: TriageOptions,
): Promise<TriageSummary> {
  const caller = options.caller ?? "api:emails.triage";
  const items: TriageItem[] = [];

  const refs = await listTriageInbox(client);

  for (const ref of refs) {
    try {
      const existing = await db
        .select({ id: processedEmails.id, outcome: processedEmails.outcome })
        .from(processedEmails)
        .where(and(eq(processedEmails.account, account), eq(processedEmails.id, ref.id)))
        .limit(1);
      // Error rows are retried; only "successful" outcomes (matched_rule / needs_review)
      // count as already-processed.
      if (existing.length > 0 && existing[0].outcome !== "error") {
        items.push({
          gmail_id: ref.id,
          thread_id: ref.threadId,
          subject: { account, from: null, to: null, subject: null, snippet: "", labels: [], received_at: null },
          outcome: "skipped",
        });
        continue;
      }

      const metadata = await getMessageMetadata(client, ref.id);
      const subject = buildSubject(metadata, account);
      const match = await evaluate(TRIAGE_DOMAIN, subject);

      if (match) {
        const proposal = ProposedActionSchema.parse(match.action);
        if (options.dryRun) {
          items.push({
            gmail_id: ref.id,
            thread_id: ref.threadId,
            subject,
            outcome: "would_match",
            rule_id: match.rule.id,
            proposed_action: proposal,
          });
          continue;
        }
        const action = mapCategoryToAction(proposal);
        await applyEmailAction(client, ref.id, action, {
          sessionId: options.sessionId,
          caller,
          intent: `rule:${match.rule.id}`,
          account,
        });
        await recordOutcome(db, {
          id: ref.id,
          account,
          threadId: ref.threadId,
          outcome: "matched_rule",
          outcomeId: match.rule.id,
          emailMeta: subject,
        });
        items.push({
          gmail_id: ref.id,
          thread_id: ref.threadId,
          subject,
          outcome: "matched_rule",
          rule_id: match.rule.id,
          proposed_action: proposal,
        });
        continue;
      }

      // No rule matched — call AI
      if (options.dryRun) {
        items.push({
          gmail_id: ref.id,
          thread_id: ref.threadId,
          subject,
          outcome: "would_queue",
        });
        continue;
      }

      let proposed: TriageProposal | null = null;
      let aiCallId: number | undefined;
      try {
        const result = await classify({
          classifier: TRIAGE_CLASSIFIER,
          caller,
          systemPrompt: SYSTEM_PROMPT,
          schema: ProposedActionSchema,
          input: buildClassifierInput(metadata),
        });
        proposed = result.output;
        aiCallId = result.callId;
      } catch (err) {
        // Configuration-level failure (no API key) — abort the whole run so we
        // don't grind through N identical errors. The route surfaces a clear
        // banner from the bubble-out.
        if (err instanceof MissingAnthropicKeyError) {
          throw err;
        }
        // ClassificationParseError already persists the ai_calls row; record the email as errored.
        const message =
          err instanceof ClassificationParseError
            ? `classifier output rejected (ai_call ${err.callId})`
            : err instanceof Error
              ? err.message
              : String(err);
        await recordOutcome(db, {
          id: ref.id,
          account,
          threadId: ref.threadId,
          outcome: "error",
          error: message.slice(0, 4000),
        });
        items.push({
          gmail_id: ref.id,
          thread_id: ref.threadId,
          subject,
          outcome: "error",
          error: message,
        });
        continue;
      }

      // A pending review for this exact message may already exist — e.g. a
      // prior run inserted needs_review but died before recording the
      // processed_emails row. Reuse it instead of queueing a duplicate.
      const [existingReview] = await db
        .select({ id: needsReview.id })
        .from(needsReview)
        .where(
          and(
            eq(needsReview.subjectKind, "email"),
            eq(needsReview.subjectId, ref.id),
            eq(needsReview.status, "pending"),
            sql`${needsReview.subject}->>'account' = ${account}`,
          ),
        )
        .limit(1);

      let reviewId: number;
      if (existingReview) {
        reviewId = existingReview.id;
        await recordOutcome(db, {
          id: ref.id,
          account,
          threadId: ref.threadId,
          outcome: "needs_review",
          outcomeId: reviewId,
          emailMeta: subject,
        });
      } else {
        // Insert the review and record the outcome atomically so a crash can
        // never orphan a review row (which would let the email be re-triaged
        // and re-classified with a different suggestion).
        reviewId = await db.transaction(async (tx) => {
          const [reviewRow] = await tx
            .insert(needsReview)
            .values({
              domain: TRIAGE_DOMAIN,
              subject: subject as never,
              subjectKind: "email",
              subjectId: ref.id,
              aiCallId: aiCallId ?? null,
              proposedAction: proposed as never,
              status: "pending",
            })
            .returning({ id: needsReview.id });
          await recordOutcome(tx, {
            id: ref.id,
            account,
            threadId: ref.threadId,
            outcome: "needs_review",
            outcomeId: reviewRow.id,
            emailMeta: subject,
          });
          return reviewRow.id;
        });
      }

      items.push({
        gmail_id: ref.id,
        thread_id: ref.threadId,
        subject,
        outcome: "queued_for_review",
        review_id: reviewId,
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
      // Best-effort: record the failure so we have a record of what went wrong.
      try {
        await recordOutcome(db, {
          id: ref.id,
          account,
          threadId: ref.threadId,
          outcome: "error",
          error: message.slice(0, 4000),
        });
      } catch {
        /* swallow */
      }
      items.push({
        gmail_id: ref.id,
        thread_id: ref.threadId,
        subject: { account, from: null, to: null, subject: null, snippet: "", labels: [], received_at: null },
        outcome: "error",
        error: message,
      });
    }
  }

  const summary: TriageSummary = {
    total: items.length,
    matched: items.filter((i) => i.outcome === "matched_rule" || i.outcome === "would_match").length,
    queued: items.filter((i) => i.outcome === "queued_for_review" || i.outcome === "would_queue").length,
    skipped: items.filter((i) => i.outcome === "skipped").length,
    errors: items.filter((i) => i.outcome === "error").length,
    items,
  };
  return summary;
}

/**
 * Triage every configured Gmail account in turn, returning one merged summary
 * with a per-account breakdown. This is the entry point used by the UI, API,
 * and cron — `triageEmails` itself stays single-account.
 */
export async function triageAllAccounts(options: TriageOptions): Promise<TriageAllSummary> {
  const accounts = await getTriageAccounts();
  const items: TriageItem[] = [];
  const perAccount: AccountTriageCounts[] = [];

  for (const { account, client } of accounts) {
    const s = await triageEmails(client, account, options);
    items.push(...s.items);
    perAccount.push({
      account,
      total: s.total,
      matched: s.matched,
      queued: s.queued,
      skipped: s.skipped,
      errors: s.errors,
    });
  }

  return {
    total: items.length,
    matched: items.filter((i) => i.outcome === "matched_rule" || i.outcome === "would_match").length,
    queued: items.filter((i) => i.outcome === "queued_for_review" || i.outcome === "would_queue").length,
    skipped: items.filter((i) => i.outcome === "skipped").length,
    errors: items.filter((i) => i.outcome === "error").length,
    items,
    accounts: perAccount,
  };
}
