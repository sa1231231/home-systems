import { Router } from "express";
import { and, asc, desc, eq, like, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog, needsReview, processedEmails, rules } from "../db/schema.js";
import { hasGoogleCreds } from "../integrations/google/oauth.js";
import { triageAllAccounts, TRIAGE_DOMAIN, type EmailSubject } from "../sync/email-triage.js";
import { newSessionId } from "../changelog/index.js";
import { MissingAnthropicKeyError, synthesizeRule, SynthMatchSchema } from "../ai/index.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";
import { groupBySession } from "./session-groups.js";
import {
  loadCorrectionContext,
  correctRuleFiredEmail,
} from "../sync/email-correction.js";
import { correctEntry, EntryNotFoundError, AlreadyDecidedError } from "../needs-review/service.js";
import { InvalidConditionError, type Cond } from "../rules/dsl.js";

function fourteenDaysAgo(): Date {
  return new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
}

const DOMAIN = "email";
const UNSCOPED = "(unscoped)";
/** Recent rule-fired emails to surface per account in the Recent activity strip. */
const RECENT_LIMIT = 25;

export type RecentRuleFiredEmail = {
  gmailId: string;
  account: string;
  ruleId: number | null;
  ruleName: string | null;
  category: string | null;
  emailMeta: EmailSubject | null;
  lastProcessedAt: Date;
};

type RuleRow = typeof rules.$inferSelect;
type ReviewRow = typeof needsReview.$inferSelect;

/** Pull the `account` value out of a rule's (possibly compound) match condition. */
function accountOfRule(match: unknown): string | null {
  if (!match || typeof match !== "object") return null;
  const m = match as Record<string, unknown>;
  const leaves = Array.isArray(m.all)
    ? m.all
    : Array.isArray(m.any)
      ? m.any
      : [m];
  for (const leaf of leaves) {
    if (
      leaf &&
      typeof leaf === "object" &&
      (leaf as Record<string, unknown>).field === "account" &&
      (leaf as Record<string, unknown>).op === "equals" &&
      typeof (leaf as Record<string, unknown>).value === "string"
    ) {
      return (leaf as Record<string, unknown>).value as string;
    }
  }
  return null;
}

function accountOfReview(row: ReviewRow): string | null {
  const s = row.subject as Record<string, unknown> | null;
  return s && typeof s.account === "string" && s.account ? s.account : null;
}

export type AccountGroup = {
  account: string;
  rules: RuleRow[];
  pending: ReviewRow[];
  recent: RecentRuleFiredEmail[];
};

/** Group rules + pending reviews + recent rule-fires by Gmail account so the UI can tab between them. */
export function groupByAccount(
  rulesRows: RuleRow[],
  pendingRows: ReviewRow[],
  recentRows: RecentRuleFiredEmail[] = [],
): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();
  const bucket = (account: string | null): AccountGroup => {
    const key = account ?? UNSCOPED;
    let g = groups.get(key);
    if (!g) {
      g = { account: key, rules: [], pending: [], recent: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of rulesRows) bucket(accountOfRule(r.match)).rules.push(r);
  for (const p of pendingRows) bucket(accountOfReview(p)).pending.push(p);
  for (const e of recentRows) bucket(e.account || null).recent.push(e);
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.account === UNSCOPED) return 1;
    if (b.account === UNSCOPED) return -1;
    return a.account.localeCompare(b.account);
  });
  return ordered.length > 0
    ? ordered
    : [{ account: "All accounts", rules: [], pending: [], recent: [] }];
}

/**
 * Pull recent rule-fired emails for the Recent activity strip. Joins
 * processed_emails to the rule that fired so the UI can show which rule
 * handled the message + what category it landed in, and offer a Wrong-call
 * button when it got it wrong.
 *
 * Only emails captured with `email_meta` populated render here — legacy rows
 * (processed before the metadata column existed) are skipped because the UI
 * needs the from/subject/snippet to be meaningful.
 */
export async function loadRecentRuleFiredEmails(limit: number): Promise<RecentRuleFiredEmail[]> {
  const rows = await db
    .select({
      id: processedEmails.id,
      account: processedEmails.account,
      outcomeId: processedEmails.outcomeId,
      emailMeta: processedEmails.emailMeta,
      lastProcessedAt: processedEmails.lastProcessedAt,
    })
    .from(processedEmails)
    .where(eq(processedEmails.outcome, "matched_rule"))
    .orderBy(desc(processedEmails.lastProcessedAt))
    .limit(limit);

  const ruleIds = Array.from(new Set(rows.map((r) => r.outcomeId).filter((id): id is number => id != null)));
  const ruleById = new Map<number, { name: string; category: string | null }>();
  if (ruleIds.length > 0) {
    const ruleRows = await db
      .select({ id: rules.id, name: rules.name, action: rules.action })
      .from(rules)
      .where(inArray(rules.id, ruleIds));
    for (const r of ruleRows) {
      const cat =
        r.action && typeof r.action === "object"
          ? ((r.action as { category?: unknown }).category as string | undefined) ?? null
          : null;
      ruleById.set(r.id, { name: r.name, category: cat });
    }
  }

  return rows
    .filter((r) => r.emailMeta != null)
    .map((r) => {
      const rule = r.outcomeId != null ? ruleById.get(r.outcomeId) ?? null : null;
      return {
        gmailId: r.id,
        account: r.account,
        ruleId: r.outcomeId,
        ruleName: rule?.name ?? null,
        category: rule?.category ?? null,
        emailMeta: r.emailMeta as EmailSubject,
        lastProcessedAt: r.lastProcessedAt,
      };
    });
}

const ProposeBody = z.object({
  account: z.string().default(""),
  message_id: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
});

const ApplyBody = z.object({
  account: z.string().default(""),
  message_id: z.string().min(1),
  category: z.enum(["noise", "worth_reading", "needs_reply"]),
  match: z.string().min(1), // JSON-encoded
  reasoning: z.string().trim().min(1).max(500),
  rule_name: z.string().trim().max(200).optional(),
  reason: z.string().trim().min(1).max(2000),
  review_id: z.coerce.number().int().positive().optional(),
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function makeGmailUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [rulesRows, pendingRows, run, activityRows, recentRows] = await Promise.all([
      db
        .select()
        .from(rules)
        .where(and(eq(rules.domain, DOMAIN), eq(rules.enabled, true)))
        .orderBy(asc(rules.priority), desc(rules.id))
        .limit(200),
      db
        .select()
        .from(needsReview)
        .where(and(eq(needsReview.domain, DOMAIN), eq(needsReview.status, "pending")))
        .orderBy(desc(needsReview.id))
        .limit(200),
      latestRunFor("email"),
      db
        .select()
        .from(changelog)
        .where(and(like(changelog.operation, "email.%"), gte(changelog.createdAt, fourteenDaysAgo())))
        .orderBy(desc(changelog.id))
        .limit(500),
      loadRecentRuleFiredEmails(RECENT_LIMIT * 4),
    ]);
    const sessionGroups = groupBySession(activityRows).slice(0, 30);
    res.render("gmail", {
      accountGroups: groupByAccount(rulesRows, pendingRows, recentRows),
      flash: null,
      cron: cronInfoForDomain("email"),
      run,
      sessionGroups,
    });
  });

  router.get("/triage-status", async (req, res) => {
    const polling = req.query.polling === "1";
    const run = await latestRunFor("email");
    if (polling && run && run.status !== "running") {
      const completedMs = run.completedAt ? new Date(run.completedAt).getTime() : 0;
      if (completedMs && Date.now() - completedMs <= 60_000) {
        res.setHeader("HX-Refresh", "true");
        res.send("");
        return;
      }
    }
    res.render("partials/_triage-status", { run, statusUrl: "/ui/gmail/triage-status" });
  });

  router.post("/triage", async (req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const sessionId = req.sessionId ?? newSessionId();
      const summary = await withTriageRun("email", sessionId, "ui:gmail.triage", () =>
        triageAllAccounts({
          sessionId,
          caller: "ui:gmail.triage",
        }),
      );
      const perAccount = summary.accounts
        .map(
          (a) =>
            `${a.account}: matched=${a.matched} queued=${a.queued} skipped=${a.skipped} errors=${a.errors}`,
        )
        .join(" · ");
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Triage done across ${summary.accounts.length} account(s): ` +
          `matched=${summary.matched} queued=${summary.queued} skipped=${summary.skipped} ` +
          `errors=${summary.errors} total=${summary.total}<br><span class="muted">${perAccount}</span></div>`,
      );
    } catch (err) {
      if (err instanceof MissingAnthropicKeyError) {
        res
          .status(503)
          .send(
            `<div class="flash err">ANTHROPIC_API_KEY is not set in Railway. Set it in the home-systems service variables and redeploy; the cron will pick it up automatically.</div>`,
          );
        return;
      }
      const message = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res.status(500).send(`<div class="flash err">Triage failed: ${message}</div>`);
    }
  });

  // Step 1 of the correction flow: user types a free-text reason; we synthesize
  // a proposed exception rule via LLM and render the editable form. Works for
  // both rule-fired emails (no needs_review row yet) and LLM-fired (existing
  // pending review).
  router.post("/correct/propose", async (req, res) => {
    let body: z.infer<typeof ProposeBody>;
    try {
      body = ProposeBody.parse(req.body ?? {});
    } catch {
      res.status(400).send(`<div class="flash err">Invalid request.</div>`);
      return;
    }
    const ctx = await loadCorrectionContext(body.account, body.message_id);
    if (!ctx) {
      res
        .status(404)
        .send(`<div class="flash err">No triage record for that message.</div>`);
      return;
    }
    let result;
    try {
      result = await synthesizeRule({
        email: {
          account: ctx.account,
          from: ctx.emailMeta.from,
          to: ctx.emailMeta.to,
          subject: ctx.emailMeta.subject,
          snippet: ctx.emailMeta.snippet,
          labels: ctx.emailMeta.labels,
        },
        current: ctx.firedRule
          ? {
              category: normalizeCategory(ctx.firedRule.category),
              source: "rule",
              firedRuleName: ctx.firedRule.name,
              firedMatch: ctx.firedRule.match,
            }
          : { category: "noise", source: "llm" },
        reason: body.reason,
        caller: "ui:gmail.correct.propose",
      });
    } catch (err) {
      if (err instanceof MissingAnthropicKeyError) {
        res
          .status(503)
          .send(
            `<div class="flash err">ANTHROPIC_API_KEY is not set; cannot synthesize rule.</div>`,
          );
        return;
      }
      const message = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;");
      res.status(500).send(`<div class="flash err">Synthesis failed: ${message}</div>`);
      return;
    }
    res.render("partials/_correction-form", {
      phase: "review",
      account: ctx.account,
      messageId: ctx.gmailId,
      emailMeta: ctx.emailMeta,
      firedRule: ctx.firedRule ?? null,
      existingReviewId: ctx.existingReviewId ?? null,
      reason: body.reason,
      proposal: result.output,
      proposalMatchJson: JSON.stringify(result.output.match),
      proposedRuleName: defaultRuleName(ctx),
    });
  });

  // Step 2 of the correction flow: user confirms (possibly after editing the
  // proposed rule). We create the exception rule with priority above whatever
  // fired wrong, reverse the original Gmail action, and on success refresh
  // the page so the user sees the new rule + updated Recent activity.
  router.post("/correct/apply", async (req, res) => {
    let body: z.infer<typeof ApplyBody>;
    try {
      body = ApplyBody.parse(req.body ?? {});
    } catch {
      res.status(400).send(`<div class="flash err">Invalid request.</div>`);
      return;
    }
    let match: Cond;
    try {
      match = JSON.parse(body.match);
    } catch {
      res.status(400).send(`<div class="flash err">Match condition is not valid JSON.</div>`);
      return;
    }
    const ctx = await loadCorrectionContext(body.account, body.message_id);
    if (!ctx) {
      res.status(404).send(`<div class="flash err">No triage record for that message.</div>`);
      return;
    }
    // Always scope new email rules to the account they came from — prevents
    // cross-account false matches and keeps rules out of the "(unscoped)" tab.
    match = wrapMatchWithAccount(match, ctx.account);
    try {
      // LLM-fired path: there's already a pending needs_review row — route
      // through the existing correctEntry so all the standard audit fields
      // (decidedBy, promotedToRuleId, applier-driven Gmail action) fire.
      if (ctx.existingReviewId) {
        const result = await correctEntry(ctx.existingReviewId, {
          decision: { category: body.category, reasoning: body.reasoning },
          promoteToRule: {
            name: body.rule_name || `auto: corrected #${ctx.existingReviewId}`,
            match,
          },
          sessionId: req.sessionId ?? newSessionId(),
          caller: "ui:gmail.correct.apply",
          decidedBy: "ui:gmail.correct",
        });
        res.setHeader("HX-Refresh", "true");
        res.send(
          `<div class="flash ok">Correction applied (rule #${result.promotedRuleId ?? "—"}).</div>`,
        );
        return;
      }

      // Rule-fired path: no pending review; create the audit row + exception
      // rule + reverse the original Gmail action.
      const result = await correctRuleFiredEmail({
        context: ctx,
        category: body.category,
        match,
        reasoning: body.reasoning,
        reason: body.reason,
        ruleName: body.rule_name,
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:gmail.correct.apply",
        decidedBy: "ui:gmail.correct",
      });
      res.setHeader("HX-Refresh", "true");
      const reverseNote = result.reversedChangelogId
        ? ` Reversed original action (changelog #${result.reversedChangelogId}).`
        : result.reverseError
          ? ` Could not reverse action: ${escapeHtml(result.reverseError)}`
          : "";
      const applyNote = result.applied
        ? ` Re-applied new label.`
        : result.applyError
          ? ` Re-label failed: ${escapeHtml(result.applyError)}`
          : "";
      res.send(
        `<div class="flash ok">Correction saved as rule #${result.ruleId ?? "—"} (review #${result.reviewId}).${reverseNote}${applyNote}</div>`,
      );
    } catch (err) {
      if (err instanceof InvalidConditionError) {
        res.status(400).send(`<div class="flash err">Invalid match: ${escapeHtml(err.message)}</div>`);
        return;
      }
      if (err instanceof EntryNotFoundError) {
        res.status(404).send(`<div class="flash err">Review not found.</div>`);
        return;
      }
      if (err instanceof AlreadyDecidedError) {
        res
          .status(409)
          .send(`<div class="flash err">That review was already decided.</div>`);
        return;
      }
      const message = (err instanceof Error ? err.message : String(err)).replace(/</g, "&lt;");
      res.status(500).send(`<div class="flash err">Correction failed: ${message}</div>`);
    }
  });

  return router;
}

function defaultRuleName(ctx: { account: string; gmailId: string }): string {
  const account = ctx.account ? ctx.account + " " : "";
  return `auto: correction ${account}${ctx.gmailId}`.slice(0, 200);
}

/** Coerce a stored rule category to the synthesizer's enum, defaulting to noise. */
function normalizeCategory(cat: string | null): "noise" | "worth_reading" | "needs_reply" {
  if (cat === "worth_reading" || cat === "needs_reply") return cat;
  return "noise";
}

/**
 * Force the synthesized match to be account-scoped. Email rules without an
 * `account` leaf would fire across every Gmail account in the system — and
 * also bucket into an "(unscoped)" tab in the UI. We always prepend the
 * leaf for the email's account, unless one is already present.
 */
function wrapMatchWithAccount(match: Cond, account: string): Cond {
  if (!account) return match;
  const accountLeaf: Cond = { field: "account", op: "equals", value: account };
  const hasAccountLeaf = (c: Cond): boolean => {
    if (typeof c !== "object" || c == null) return false;
    if ("all" in c && Array.isArray(c.all)) return c.all.some(hasAccountLeaf);
    if ("any" in c && Array.isArray(c.any)) return c.any.some(hasAccountLeaf);
    if ("field" in c) return c.field === "account" && c.op === "equals";
    return false;
  };
  if (hasAccountLeaf(match)) return match;
  if (typeof match === "object" && match != null && "all" in match && Array.isArray(match.all)) {
    return { all: [accountLeaf, ...match.all] };
  }
  return { all: [accountLeaf, match] };
}
