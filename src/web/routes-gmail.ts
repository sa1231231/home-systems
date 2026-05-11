import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";

const DOMAIN = "email";

export function makeGmailUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [rulesRows, pendingRows] = await Promise.all([
      db
        .select()
        .from(rules)
        .where(eq(rules.domain, DOMAIN))
        .orderBy(asc(rules.priority), desc(rules.id))
        .limit(200),
      db
        .select()
        .from(needsReview)
        .where(and(eq(needsReview.domain, DOMAIN), eq(needsReview.status, "pending")))
        .orderBy(desc(needsReview.id))
        .limit(200),
    ]);
    res.render("gmail", {
      rules: rulesRows,
      pending: pendingRows,
      flash: null,
    });
  });

  return router;
}
