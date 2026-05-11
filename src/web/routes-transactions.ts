import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { readCategoriesEnum } from "../integrations/google/sheets-transactions.js";

const DOMAIN = "transaction";

export type TransactionsRouterOptions = {
  sheetId?: string;
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

  return router;
}
