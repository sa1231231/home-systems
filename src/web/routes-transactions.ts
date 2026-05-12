import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readCategoriesEnum } from "../integrations/google/sheets-transactions.js";
import { triageTransactions } from "../sync/transaction-triage.js";
import { inferTransactionRules } from "../sync/transaction-rules.js";
import { newSessionId } from "../changelog/index.js";
import { MissingAnthropicKeyError } from "../ai/index.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";

const DOMAIN = "transaction";

const TriageBody = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type TransactionsRouterOptions = {
  sheetId?: string;
  transactionsTab: string;
  categoriesTab: string;
};

export function makeTransactionsUiRouter(opts: TransactionsRouterOptions): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [rulesRows, pendingRows] = await Promise.all([
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
    ]);

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
      rules: rulesRows,
      pending: pendingRows,
      categories,
      flash: null,
      warning,
      cron: cronInfoForDomain("transaction"),
      sheetUrl,
      run,
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
            target: {
              sheetId: opts.sheetId!,
              transactionsTab: opts.transactionsTab,
              categoriesTab: opts.categoriesTab,
            },
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
      const message = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res.status(500).send(`<div class="flash err">Triage failed: ${message}</div>`);
    }
  });

  // One-shot bootstrap: scan the sheet for rows already categorized into the
  // canonical enum and synthesize deterministic rules for them. Idempotent —
  // re-running only adds rules for descriptions that don't already have one.
  router.post("/infer-rules", async (_req, res) => {
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
      const result = await inferTransactionRules(getOAuthClient(), {
        sheetId: opts.sheetId,
        transactionsTab: opts.transactionsTab,
        categoriesTab: opts.categoriesTab,
      });
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Inferred rules: created=${result.created}, already had ${result.already_exists}, ambiguous ${result.ambiguous}, ${result.tiller_skipped} skipped (non-canonical categories), ${result.empty_skipped} empty rows.</div>`,
      );
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res
        .status(500)
        .send(`<div class="flash err">Infer rules failed: ${message}</div>`);
    }
  });

  return router;
}
