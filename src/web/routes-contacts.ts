import { Router } from "express";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";

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
    });
  });

  return router;
}
