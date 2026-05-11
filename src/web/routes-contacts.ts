import { Router } from "express";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";
import {
  hasGoogleCreds,
  getOAuthClient,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { runSync } from "../sync/contacts.js";
import { cronInfoForDomain } from "./cron-info.js";

const DOMAIN = "contact";

function sevenDaysAgo(now: Date = new Date()): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

export function makeContactsUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const since = sevenDaysAgo();
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
        .where(and(eq(changelog.targetKind, "contact"), gte(changelog.createdAt, since)))
        .orderBy(desc(changelog.id))
        .limit(200),
    ]);
    res.render("contacts", {
      rules: rulesRows,
      pending: pendingRows,
      activity: activityRows,
      flash: null,
      cron: cronInfoForDomain("contact"),
    });
  });

  router.post("/sync", async (_req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const creds = requireGoogleCreds();
      const { summary } = await runSync(getOAuthClient(), creds.sheetId, { dryRun: false });
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Sync done: inserted=${summary.inserted} refreshed=${summary.refreshed} unchanged=${summary.unchanged} ambiguous=${summary.ambiguous}</div>`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .send(
          `<div class="flash err">Sync failed: ${message.replace(/</g, "&lt;")}</div>`,
        );
    }
  });

  return router;
}
