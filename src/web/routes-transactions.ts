import { Router } from "express";
import { and, asc, desc, eq, gte, like, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readCategoriesEnum } from "../integrations/google/sheets-transactions.js";
import { applyRuleToSheet, triageTransactions } from "../sync/transaction-triage.js";
import {
  addSituationalMerchant,
  consolidateRules,
  containsMerchantMatch,
  findConsolidations,
} from "../sync/transaction-rules.js";
import { isSituational } from "../rules/engine.js";
import { getRule, RuleNotFoundError } from "../rules/service.js";
import { approveEntry, correctEntry } from "../needs-review/service.js";
import { getDomainConfig } from "../needs-review/domains.js";
import { newSessionId } from "../changelog/index.js";
import { MissingAnthropicKeyError } from "../ai/index.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";
import { groupBySession } from "./session-groups.js";

const DOMAIN = "transaction";

const TriageBody = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const IdParam = z.coerce.number().int().positive();

const DecideBody = z.object({
  category: z.string().min(1).max(200),
  rule_scope: z.enum(["exact", "contains", "once", "situational", "account"]),
  rule_value: z.string().max(200).optional(),
});

// Account/card-wide rules are deliberate catch-alls — give them a higher
// priority number so specific merchant rules (default 100) still win first.
const ACCOUNT_RULE_PRIORITY = 200;

const SituationalBody = z.object({
  value: z.string().min(1).max(200),
});

const ConsolidateBody = z.object({
  token: z.string().min(1).max(100),
  category: z.string().min(1).max(200),
  ruleIds: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(",")
        .map((p) => Number.parseInt(p.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0),
    )
    .refine((arr) => arr.length > 0, "no rule ids provided"),
});

function escapeHtml(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type TransactionsRouterOptions = {
  sheetId?: string;
  transactionsTab: string;
  categoriesTab: string;
};

export function makeTransactionsUiRouter(opts: TransactionsRouterOptions): Router {
  const router = Router();

  function sheetTarget() {
    return {
      sheetId: opts.sheetId!,
      transactionsTab: opts.transactionsTab,
      categoriesTab: opts.categoriesTab,
    };
  }

  router.get("/", async (_req, res) => {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const [rulesRows, pendingRows, activityRows] = await Promise.all([
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
      db
        .select()
        .from(changelog)
        .where(
          and(
            or(
              eq(changelog.targetKind, "transaction"),
              like(changelog.operation, "transaction.%"),
              like(changelog.operation, "transactions.%"),
            ),
            gte(changelog.createdAt, since),
          ),
        )
        .orderBy(desc(changelog.id))
        .limit(500),
    ]);
    const sessionGroups = groupBySession(activityRows).slice(0, 30);

    // Situational merchants are marker rules ({situational:true}); keep them
    // out of the category-rule list and the consolidation scan.
    const categoryRules = rulesRows.filter((r) => !isSituational(r.action));
    const situationalRules = rulesRows.filter((r) => isSituational(r.action));
    const consolidations = findConsolidations(categoryRules);

    let categories: string[] = [];
    let warning: string | null = null;
    if (!opts.sheetId) {
      warning = "TRANSACTIONS_SHEET_ID is not configured; categorization is disabled.";
    } else if (!hasGoogleCreds()) {
      warning = "Google credentials are not configured.";
    } else {
      try {
        categories = await readCategoriesEnum(getOAuthClient(), opts.sheetId, opts.categoriesTab);
      } catch (err) {
        warning = `Failed to read Categories tab: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const sheetUrl = opts.sheetId
      ? `https://docs.google.com/spreadsheets/d/${opts.sheetId}/edit`
      : null;
    const run = await latestRunFor("transaction");
    res.render("transactions", {
      rules: categoryRules,
      situationalRules,
      consolidations,
      pending: pendingRows,
      categories,
      flash: null,
      warning,
      cron: cronInfoForDomain("transaction"),
      sheetUrl,
      run,
      sessionGroups,
    });
  });

  // Polled by the in-progress banner. When called with ?polling=1 and the run
  // has just finished, sets HX-Refresh so the page reloads with new state.
  router.get("/triage-status", async (req, res) => {
    const polling = req.query.polling === "1";
    const run = await latestRunFor("transaction");
    if (polling && run && run.status !== "running") {
      const completedMs = run.completedAt ? new Date(run.completedAt).getTime() : 0;
      if (completedMs && Date.now() - completedMs <= 60_000) {
        res.setHeader("HX-Refresh", "true");
        res.send("");
        return;
      }
    }
    res.render("partials/_triage-status", {
      run,
      statusUrl: "/ui/transactions/triage-status",
    });
  });

  // Manual trigger. Returns an HTMX banner with the run summary and signals
  // a full-page refresh so newly queued pending rows show up.
  router.post("/triage", async (req, res) => {
    if (!opts.sheetId) {
      res
        .status(503)
        .send(`<div class="flash err">TRANSACTIONS_SHEET_ID is not configured.</div>`);
      return;
    }
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const { limit } = TriageBody.parse(req.body ?? {});
      const sessionId = req.sessionId ?? newSessionId();
      const summary = await withTriageRun(
        "transaction",
        sessionId,
        "ui:transactions.triage",
        () =>
          triageTransactions(getOAuthClient(), {
            limit,
            sessionId,
            caller: "ui:transactions.triage",
            target: sheetTarget(),
          }),
      );
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Triage done: matched=${summary.matched} queued=${summary.queued} skipped=${summary.skipped} errors=${summary.errors} total=${summary.total}</div>`,
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
      const message = escapeHtml(err instanceof Error ? err.message : String(err));
      res.status(500).send(`<div class="flash err">Triage failed: ${message}</div>`);
    }
  });

  // Decide a pending transaction review with an explicit rule scope:
  //   exact       — promote an exact full_description rule (AI's default)
  //   contains    — promote one "merchant contains <token>" rule
  //   once        — apply the category to this row only, no rule
  //   situational — apply once + register a situational merchant (never auto-ruled)
  //   account     — promote a card/account-wide rule (every txn on this account)
  router.post("/review/:id/decide", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    const [pending] = await db.select().from(needsReview).where(eq(needsReview.id, id));
    if (!pending) {
      res.status(404).send("not found");
      return;
    }
    try {
      let body: z.infer<typeof DecideBody>;
      try {
        body = DecideBody.parse(req.body ?? {});
      } catch {
        res
          .status(400)
          .render("partials/_review-row-error", { entry: pending, error: "Invalid decision form." });
        return;
      }
      const token = (body.rule_value ?? "").trim();
      if ((body.rule_scope === "contains" || body.rule_scope === "situational") && !token) {
        res.status(400).render("partials/_review-row-error", {
          entry: pending,
          error: "A merchant token is required for that option.",
        });
        return;
      }

      const subject = (pending.subject ?? {}) as Record<string, unknown>;
      const account = typeof subject.account === "string" ? subject.account.trim() : "";
      if (body.rule_scope === "account" && !account) {
        res.status(400).render("partials/_review-row-error", {
          entry: pending,
          error: "This transaction has no account/card recorded, so a card-wide rule can't be made.",
        });
        return;
      }

      const cfg = getDomainConfig(pending.domain);
      const aiCategory = (pending.proposedAction as { category?: string } | null)?.category ?? null;
      const sessionId = req.sessionId ?? newSessionId();

      let promoteToRule: { name: string; match: unknown; priority?: number } | undefined;
      if (body.rule_scope === "exact") {
        promoteToRule = { name: cfg.defaultRuleName(pending), match: cfg.defaultMatch(pending) };
      } else if (body.rule_scope === "contains") {
        promoteToRule = {
          name: `auto: contains "${token}"`,
          match: containsMerchantMatch(token),
        };
      } else if (body.rule_scope === "account") {
        promoteToRule = {
          name: `card: ${account}`,
          match: { op: "equals", field: "account", value: account },
          priority: ACCOUNT_RULE_PRIORITY,
        };
      }
      // "once" and "situational" promote no category rule.

      const result =
        aiCategory && body.category === aiCategory
          ? await approveEntry(id, { promoteToRule, sessionId, caller: "ui:transactions.decide" })
          : await correctEntry(id, {
              decision: cfg.buildCorrectedDecision(body.category, aiCategory ?? "unknown"),
              promoteToRule,
              sessionId,
              caller: "ui:transactions.decide",
            });

      if (body.rule_scope === "situational") {
        await addSituationalMerchant(token);
      }

      res.render("partials/_transaction-review-row", {
        entry: result.entry,
        applyOutcome: result.apply,
        includeBulkCheckbox: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).render("partials/_review-row-error", { entry: pending, error: message });
    }
  });

  // Register a situational merchant (a marker rule). Idempotent.
  router.post("/situational", async (req, res) => {
    try {
      const { value } = SituationalBody.parse(req.body ?? {});
      await addSituationalMerchant(value);
      res.setHeader("HX-Refresh", "true");
      res.send(`<div class="flash ok">Situational merchant added — its transactions always go to review.</div>`);
    } catch (err) {
      const message = escapeHtml(err instanceof Error ? err.message : String(err));
      res.status(400).send(`<div class="flash err">${message}</div>`);
    }
  });

  // Retroactively apply one rule to existing uncategorized sheet rows.
  router.post("/rules/:id/apply", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send(`<div class="flash err">Invalid id.</div>`);
      return;
    }
    if (!opts.sheetId) {
      res.status(503).send(`<div class="flash err">TRANSACTIONS_SHEET_ID is not configured.</div>`);
      return;
    }
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const rule = await getRule(id);
      if (rule.domain !== DOMAIN) {
        res.status(400).send(`<div class="flash err">Rule #${id} is not a transaction rule.</div>`);
        return;
      }
      const sessionId = req.sessionId ?? newSessionId();
      const result = await applyRuleToSheet(getOAuthClient(), sheetTarget(), rule, {
        sessionId,
        caller: "ui:transactions.apply-rule",
      });
      const errNote = result.errors > 0 ? ` ${result.errors} failed.` : "";
      res.send(
        `<div class="flash ok">Rule #${id}: categorized ${result.applied} uncategorized transaction(s).${errNote}</div>`,
      );
    } catch (err) {
      const status = err instanceof RuleNotFoundError ? 404 : 500;
      const message = escapeHtml(err instanceof Error ? err.message : String(err));
      res.status(status).send(`<div class="flash err">Apply failed: ${message}</div>`);
    }
  });

  // Consolidate near-duplicate exact rules into one "merchant contains" rule.
  router.post("/cleanup/consolidate", async (req, res) => {
    try {
      const body = ConsolidateBody.parse(req.body ?? {});
      const rule = await consolidateRules({
        token: body.token,
        category: body.category,
        ruleIds: body.ruleIds,
      });
      let appliedNote = "";
      if (opts.sheetId && hasGoogleCreds()) {
        const sessionId = req.sessionId ?? newSessionId();
        const applied = await applyRuleToSheet(getOAuthClient(), sheetTarget(), rule, {
          sessionId,
          caller: "ui:transactions.consolidate",
        });
        appliedNote = ` Categorized ${applied.applied} uncategorized row(s).`;
      }
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Consolidated ${body.ruleIds.length} rules into rule #${rule.id}.${appliedNote}</div>`,
      );
    } catch (err) {
      const message = escapeHtml(err instanceof Error ? err.message : String(err));
      res.status(400).send(`<div class="flash err">Consolidate failed: ${message}</div>`);
    }
  });

  return router;
}
