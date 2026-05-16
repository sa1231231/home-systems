import { Router } from "express";
import { and, asc, desc, eq, like, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds } from "../integrations/google/oauth.js";
import { triageAllAccounts } from "../sync/email-triage.js";
import { newSessionId } from "../changelog/index.js";
import { MissingAnthropicKeyError } from "../ai/index.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";
import { groupBySession } from "./session-groups.js";

function fourteenDaysAgo(): Date {
  return new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
}

const DOMAIN = "email";
const UNSCOPED = "(unscoped)";

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

export type AccountGroup = { account: string; rules: RuleRow[]; pending: ReviewRow[] };

/** Group rules + pending reviews by Gmail account so the UI can tab between them. */
export function groupByAccount(rulesRows: RuleRow[], pendingRows: ReviewRow[]): AccountGroup[] {
  const groups = new Map<string, AccountGroup>();
  const bucket = (account: string | null): AccountGroup => {
    const key = account ?? UNSCOPED;
    let g = groups.get(key);
    if (!g) {
      g = { account: key, rules: [], pending: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of rulesRows) bucket(accountOfRule(r.match)).rules.push(r);
  for (const p of pendingRows) bucket(accountOfReview(p)).pending.push(p);
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.account === UNSCOPED) return 1;
    if (b.account === UNSCOPED) return -1;
    return a.account.localeCompare(b.account);
  });
  return ordered.length > 0 ? ordered : [{ account: "All accounts", rules: [], pending: [] }];
}

export function makeGmailUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [rulesRows, pendingRows, run, activityRows] = await Promise.all([
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
    ]);
    const sessionGroups = groupBySession(activityRows).slice(0, 30);
    res.render("gmail", {
      accountGroups: groupByAccount(rulesRows, pendingRows),
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

  return router;
}
