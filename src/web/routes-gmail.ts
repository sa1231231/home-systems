import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { triageEmails } from "../sync/email-triage.js";
import { newSessionId } from "../changelog/index.js";
import { cronInfoForDomain } from "./cron-info.js";

const DOMAIN = "email";

const TriageBody = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export function makeGmailUiRouter(): Router {
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
    res.render("gmail", {
      rules: rulesRows,
      pending: pendingRows,
      flash: null,
      cron: cronInfoForDomain("email"),
    });
  });

  router.post("/triage", async (req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const { limit } = TriageBody.parse(req.body ?? {});
      const sessionId = req.sessionId ?? newSessionId();
      const summary = await triageEmails(getOAuthClient(), {
        limit,
        sessionId,
        caller: "ui:gmail.triage",
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
