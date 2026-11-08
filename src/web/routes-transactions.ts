import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, gte, like, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readTransactionsSheet } from "../integrations/google/sheets-transactions.js";
import { buildTransactionAnalytics } from "../sync/transaction-analytics.js";
import { AUTOCAT_DEFAULT_TAB } from "../sync/transaction-autocat.js";
import {
  cashflowBars,
  categoryBars,
  fmtUsd,
  merchantBars,
  monthLabel,
  trendLine,
} from "./transaction-charts.js";
import { triageTransactions } from "../sync/transaction-triage.js";
import { newSessionId } from "../changelog/index.js";
import { MissingAnthropicKeyError } from "../ai/index.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";
import { groupBySession } from "./session-groups.js";

const TriageBody = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

function escapeHtml(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type DashboardViewModel = {
  currentMonthLabel: string | null;
  totals: { income: number; expense: number; net: number };
  totalsFmt: { income: string; expense: string; net: string };
  uncategorizedCount: number;
  categoryBars: string;
  merchantBars: string;
  cashflowBars: string;
  trendLine: string;
};

/** Read-only: aggregate the Tiller rows into chart HTML for the dashboard. */
function buildDashboard(rows: Parameters<typeof buildTransactionAnalytics>[0]): DashboardViewModel {
  const a = buildTransactionAnalytics(rows);
  return {
    currentMonthLabel: a.currentMonth ? monthLabel(a.currentMonth) : null,
    totals: a.monthlyTotals,
    totalsFmt: {
      income: fmtUsd(a.monthlyTotals.income),
      expense: fmtUsd(a.monthlyTotals.expense),
      net: fmtUsd(a.monthlyTotals.net),
    },
    uncategorizedCount: a.uncategorizedCount,
    categoryBars: categoryBars(a.spendByCategory),
    merchantBars: merchantBars(a.topMerchants),
    cashflowBars: cashflowBars(a.cashflowByMonth),
    trendLine: trendLine(a.spendTrend),
  };
}

export type TransactionsRouterOptions = {
  sheetId?: string;
  transactionsTab: string;
  categoriesTab: string;
  autoCatTab?: string;
};

export function makeTransactionsUiRouter(opts: TransactionsRouterOptions): Router {
  const router = Router();

  // Each triage run fans out to Anthropic + Google Sheets, so cap how often it
  // can be kicked off (it's already auth-gated; this bounds cost if a session
  // is left hammering "Run now").
  const triageLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: `<div class="flash err">Too many triage runs. Wait a few minutes and retry.</div>`,
  });

  function sheetTarget() {
    return {
      sheetId: opts.sheetId!,
      transactionsTab: opts.transactionsTab,
      categoriesTab: opts.categoriesTab,
      autoCatTab: opts.autoCatTab ?? AUTOCAT_DEFAULT_TAB,
    };
  }

  router.get("/", async (_req, res) => {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const activityRows = await db
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
      .limit(500);
    const sessionGroups = groupBySession(activityRows).slice(0, 30);

    let warning: string | null = null;
    let dashboard: DashboardViewModel | null = null;
    if (!opts.sheetId) {
      warning = "TRANSACTIONS_SHEET_ID is not configured; categorization is disabled.";
    } else if (!hasGoogleCreds()) {
      warning = "Google credentials are not configured.";
    } else {
      try {
        const tab = await readTransactionsSheet(
          getOAuthClient(),
          opts.sheetId,
          opts.transactionsTab,
        );
        dashboard = buildDashboard(tab.rows);
      } catch (err) {
        warning = `Failed to read Transactions tab: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const sheetUrl = opts.sheetId
      ? `https://docs.google.com/spreadsheets/d/${opts.sheetId}/edit`
      : null;
    const run = await latestRunFor("transaction");
    res.render("transactions", {
      flash: null,
      warning,
      cron: cronInfoForDomain("transaction"),
      sheetUrl,
      run,
      sessionGroups,
      dashboard,
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

  // Manual trigger. Returns an HTMX banner with the run summary and signals a
  // full-page refresh so the dashboard and activity reflect the new run.
  router.post("/triage", triageLimiter, async (req, res) => {
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
        `<div class="flash ok">Triage done: rule-matched=${summary.matched} AI-applied=${summary.applied} skipped=${summary.skipped} errors=${summary.errors} total=${summary.total}</div>`,
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

  return router;
}
