import { and, desc, eq, isNull } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { changelog, needsReview, processedEmails, rules } from "../db/schema.js";
import { reverseOne } from "../changelog/undo.js";
import {
  promoteRule,
  autoResolveMatching,
  type ApplyMeta,
} from "../needs-review/service.js";
import {
  reviewAppliers as defaultAppliers,
  type ApplierRegistry,
} from "../needs-review/appliers.js";
import { TRIAGE_DOMAIN, type EmailSubject } from "./email-triage.js";
import { EMAIL_MODIFY_OP } from "./email-actions.js";
import { validateCondition, type Cond } from "../rules/dsl.js";

export type CorrectedEmailContext = {
  account: string;
  gmailId: string;
  /** Subject metadata captured at triage time (used to seed the audit row). */
  emailMeta: EmailSubject;
  /** The rule that originally fired, when this was a rule-fired classification. */
  firedRule?: {
    id: number;
    name: string;
    priority: number;
    match: Cond;
    /** Category the rule put this email into ("noise" | "worth_reading" | "needs_reply"). */
    category: string | null;
  };
  /** When the original classification was an LLM-fired pending review, its id. */
  existingReviewId?: number;
};

export type CorrectRuleFiredInput = {
  context: CorrectedEmailContext;
  /** Result of synthesis (possibly user-edited). */
  category: "noise" | "worth_reading" | "needs_reply";
  match: Cond;
  reasoning: string;
  /** User's free-text reason — stored on the audit row. */
  reason: string;
  /** Optional rule name override; otherwise auto-generated. */
  ruleName?: string;
  /** Caller info for changelog/audit. */
  sessionId: string;
  caller: string;
  decidedBy?: string;
};

export type CorrectRuleFiredResult = {
  reviewId: number;
  ruleId: number | null;
  reversedChangelogId: number | null;
  reverseError: string | null;
};

const PRIORITY_FALLBACK = 50;

function defaultRuleName(ctx: CorrectedEmailContext): string {
  const account = ctx.account ? ctx.account + " " : "";
  return `auto: correction ${account}${ctx.gmailId}`.slice(0, 200);
}

/**
 * Look up the most recent un-undone `email.modify_labels` changelog entry for
 * this Gmail message. We can't key on the processed_emails row alone because
 * a re-triage could have re-applied an action; we want the one that's still
 * "live" on the message.
 */
export async function findLatestEmailChangelogId(
  database: typeof defaultDb,
  gmailId: string,
): Promise<number | null> {
  const [row] = await database
    .select({ id: changelog.id })
    .from(changelog)
    .where(
      and(
        eq(changelog.operation, EMAIL_MODIFY_OP),
        eq(changelog.targetKind, "email"),
        eq(changelog.targetId, gmailId),
        eq(changelog.status, "success"),
        isNull(changelog.undoneBy),
      ),
    )
    .orderBy(desc(changelog.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Load everything needed to render the Wrong-call form for a Gmail message:
 * its processed_emails outcome, the email metadata captured at triage time,
 * and (when rule-fired) the rule definition that classified it.
 */
export async function loadCorrectionContext(
  account: string,
  gmailId: string,
  database: typeof defaultDb = defaultDb,
): Promise<CorrectedEmailContext | null> {
  const [processed] = await database
    .select()
    .from(processedEmails)
    .where(and(eq(processedEmails.account, account), eq(processedEmails.id, gmailId)))
    .limit(1);
  if (!processed) return null;
  const emailMeta = (processed.emailMeta as EmailSubject | null) ?? {
    account,
    from: null,
    to: null,
    subject: null,
    snippet: "",
    labels: [],
    received_at: null,
  };

  const ctx: CorrectedEmailContext = { account, gmailId, emailMeta };

  if (processed.outcome === "matched_rule" && processed.outcomeId != null) {
    const [rule] = await database
      .select({
        id: rules.id,
        name: rules.name,
        priority: rules.priority,
        match: rules.match,
        action: rules.action,
      })
      .from(rules)
      .where(eq(rules.id, processed.outcomeId))
      .limit(1);
    if (rule) {
      const category =
        rule.action && typeof rule.action === "object"
          ? ((rule.action as { category?: unknown }).category as string | undefined) ?? null
          : null;
      ctx.firedRule = {
        id: rule.id,
        name: rule.name,
        priority: rule.priority,
        match: rule.match as Cond,
        category,
      };
    }
  } else if (processed.outcome === "needs_review" && processed.outcomeId != null) {
    ctx.existingReviewId = processed.outcomeId;
  }

  return ctx;
}

/**
 * Apply a user correction for a rule-fired email: insert an audit
 * `needs_review` row with `subjectKind='email_correction'`, promote a new
 * exception rule (priority one above the rule that fired wrong so it wins),
 * reverse the original Gmail action, and auto-resolve any other pending
 * reviews the new rule covers.
 *
 * For LLM-fired emails (those that already have a pending `needs_review`
 * row), use the existing `correctEntry` path instead — this function is
 * specifically for the rule-fired case where no review row exists yet.
 */
export async function correctRuleFiredEmail(
  input: CorrectRuleFiredInput,
  options: { database?: typeof defaultDb; registry?: ApplierRegistry } = {},
): Promise<CorrectRuleFiredResult> {
  const database = options.database ?? defaultDb;
  const registry = options.registry ?? defaultAppliers;

  validateCondition(input.match);

  const decision = { category: input.category, reasoning: input.reasoning };
  const subjectPayload = {
    ...input.context.emailMeta,
    account: input.context.account,
    gmail_id: input.context.gmailId,
    fired_rule_id: input.context.firedRule?.id ?? null,
    fired_rule_name: input.context.firedRule?.name ?? null,
  };

  // 1. Insert the audit row — captured first so promoteRule has a real id to
  //    link via createdFromReviewId.
  const [reviewRow] = await database
    .insert(needsReview)
    .values({
      domain: TRIAGE_DOMAIN,
      subject: subjectPayload as never,
      subjectKind: "email_correction",
      subjectId: input.context.gmailId,
      proposedAction: decision as never,
      status: "corrected",
      decision: {
        reason: input.reason,
        accepted: decision,
        match: input.match,
        fired_rule_id: input.context.firedRule?.id ?? null,
      } as never,
      decidedAt: new Date(),
      decidedBy: input.decidedBy ?? "ui:gmail.correct",
    })
    .returning({ id: needsReview.id });

  // 2. Promote rule one priority tier above whatever fired wrong so this
  //    exception wins on the next evaluation pass.
  const priority = input.context.firedRule
    ? Math.max(1, input.context.firedRule.priority - 1)
    : PRIORITY_FALLBACK;
  const ruleId = await promoteRule(database, {
    domain: TRIAGE_DOMAIN,
    name: input.ruleName ?? defaultRuleName(input.context),
    match: input.match,
    action: decision,
    priority,
    reviewId: reviewRow.id,
    createdBy: "correction:rule_fired",
  });

  if (ruleId !== null) {
    await database
      .update(needsReview)
      .set({ promotedToRuleId: ruleId, updatedAt: new Date() })
      .where(eq(needsReview.id, reviewRow.id));
  }

  // 3. Reverse the original Gmail action (best-effort — if it already got
  //    undone or the changelog row is gone, the rule is still in place).
  let reversedChangelogId: number | null = null;
  let reverseError: string | null = null;
  const originalChangelogId = await findLatestEmailChangelogId(database, input.context.gmailId);
  if (originalChangelogId !== null) {
    try {
      const reversal = await reverseOne(originalChangelogId, { database });
      reversedChangelogId = reversal.reversed_by;
    } catch (err) {
      reverseError = err instanceof Error ? err.message : String(err);
    }
  }

  // 4. Auto-approve any other pending reviews that the new rule covers.
  if (ruleId !== null) {
    const meta: ApplyMeta = {
      sessionId: input.sessionId,
      caller: input.caller,
      intent: `correction:rule_fired:${reviewRow.id}`,
    };
    await autoResolveMatching(database, ruleId, meta, registry);
  }

  return {
    reviewId: reviewRow.id,
    ruleId,
    reversedChangelogId,
    reverseError,
  };
}
