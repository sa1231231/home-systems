import type { OAuth2Client } from "google-auth-library";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { needsReview, processedEmails } from "../db/schema.js";
import { evaluate } from "../rules/engine.js";
import { classify, ClassificationParseError } from "../ai/index.js";
import { getMessageMetadata, listTriageInbox, type GmailMetadata } from "../integrations/google/gmail.js";
import { applyEmailAction, type EmailAction } from "./email-actions.js";

export const TRIAGE_DOMAIN = "email";
export const TRIAGE_CLASSIFIER = "email.triage";

const SYSTEM_PROMPT = `You triage emails for a personal inbox. Given an email's metadata, propose Gmail labels to add and/or remove.

Rules:
- For obvious newsletters, marketing emails, or automated notifications: archive by setting remove_labels to ["INBOX"].
- For substantive emails (from a real person, requiring action, or important): leave INBOX alone (return empty add_labels and remove_labels) so the email stays in the inbox for the user to handle.
- Use existing Gmail system labels when relevant: INBOX, UNREAD, STARRED, IMPORTANT.
- Only suggest user-defined labels (anything else) if you're confident the user already has that label or would benefit from it.
- Always provide concise reasoning under 200 characters explaining the decision.`;

export const ProposedActionSchema = z.object({
  add_labels: z.array(z.string()).default([]),
  remove_labels: z.array(z.string()).default([]),
  reasoning: z.string().min(1).max(500),
});

export type EmailSubject = {
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string;
  labels: string[];
  received_at: string | null;
};

export type TriageOptions = {
  limit: number;
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
  proposed_action?: EmailAction;
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

export function buildSubject(metadata: GmailMetadata): EmailSubject {
  return {
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

export async function triageEmails(
  client: OAuth2Client,
  options: TriageOptions,
): Promise<TriageSummary> {
  const caller = options.caller ?? "api:emails.triage";
  const items: TriageItem[] = [];

  const refs = await listTriageInbox(client, { limit: options.limit });

  for (const ref of refs) {
    try {
      const existing = await db
        .select({ id: processedEmails.id, outcome: processedEmails.outcome })
        .from(processedEmails)
        .where(eq(processedEmails.id, ref.id))
        .limit(1);
      if (existing.length > 0) {
        items.push({
          gmail_id: ref.id,
          thread_id: ref.threadId,
          subject: { from: null, to: null, subject: null, snippet: "", labels: [], received_at: null },
          outcome: "skipped",
        });
        continue;
      }

      const metadata = await getMessageMetadata(client, ref.id);
      const subject = buildSubject(metadata);
      const match = await evaluate(TRIAGE_DOMAIN, subject);

      if (match) {
        const action = match.action as EmailAction;
        if (options.dryRun) {
          items.push({
            gmail_id: ref.id,
            thread_id: ref.threadId,
            subject,
            outcome: "would_match",
            rule_id: match.rule.id,
            proposed_action: action,
          });
          continue;
        }
        await applyEmailAction(client, ref.id, action, {
          sessionId: options.sessionId,
          caller,
          intent: `rule:${match.rule.id}`,
        });
        await db.insert(processedEmails).values({
          id: ref.id,
          threadId: ref.threadId,
          outcome: "matched_rule",
          outcomeId: match.rule.id,
        });
        items.push({
          gmail_id: ref.id,
          thread_id: ref.threadId,
          subject,
          outcome: "matched_rule",
          rule_id: match.rule.id,
          proposed_action: action,
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

      let proposed: EmailAction | null = null;
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
        // ClassificationParseError already persists the ai_calls row; record the email as errored.
        const message =
          err instanceof ClassificationParseError
            ? `classifier output rejected (ai_call ${err.callId})`
            : err instanceof Error
              ? err.message
              : String(err);
        await db.insert(processedEmails).values({
          id: ref.id,
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

      const [reviewRow] = await db
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

      await db.insert(processedEmails).values({
        id: ref.id,
        threadId: ref.threadId,
        outcome: "needs_review",
        outcomeId: reviewRow.id,
      });

      items.push({
        gmail_id: ref.id,
        thread_id: ref.threadId,
        subject,
        outcome: "queued_for_review",
        review_id: reviewRow.id,
        ai_call_id: aiCallId,
        proposed_action: proposed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort: record the failure so we don't reprocess in a tight loop. Ignore
      // duplicate-key errors here — if the row already exists the orchestrator just moves on.
      try {
        await db.insert(processedEmails).values({
          id: ref.id,
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
        subject: { from: null, to: null, subject: null, snippet: "", labels: [], received_at: null },
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
