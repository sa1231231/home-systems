import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readCategoriesEnum } from "../integrations/google/sheets-transactions.js";
import { triageTransactions } from "../sync/transaction-triage.js";
import { newSessionId } from "../changelog/index.js";

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

    res.render("transactions", {
      rules: rulesRows,
      pending: pendingRows,
      categories,
      flash: null,
      warning,
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
      const summary = await triageTransactions(getOAuthClient(), {
        limit,
        sessionId,
        caller: "ui:transactions.triage",
        target: {
          sheetId: opts.sheetId,
          transactionsTab: opts.transactionsTab,
          categoriesTab: opts.categoriesTab,
        },
      });
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Triage done: matched=${summary.matched} queued=${summary.queued} skipped=${summary.skipped} errors=${summary.errors} total=${summary.total}</div>`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .send(
          `<div class="flash err">Triage failed: ${message.replace(/</g, "&lt;")}</div>`,
        );
    }
  });

  return router;
}
