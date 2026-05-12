import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { hasGoogleCreds, getOAuthClient } from "../integrations/google/oauth.js";
import { triageEmails } from "../sync/email-triage.js";
import { newSessionId } from "../changelog/index.js";
import { MissingAnthropicKeyError } from "../ai/index.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";

const DOMAIN = "email";

const TriageBody = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export function makeGmailUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [rulesRows, pendingRows, run] = await Promise.all([
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
    ]);
    res.render("gmail", {
      rules: rulesRows,
      pending: pendingRows,
      flash: null,
      cron: cronInfoForDomain("email"),
      run,
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
      const { limit } = TriageBody.parse(req.body ?? {});
      const sessionId = req.sessionId ?? newSessionId();
      const summary = await withTriageRun("email", sessionId, "ui:gmail.triage", () =>
        triageEmails(getOAuthClient(), {
          limit,
          sessionId,
          caller: "ui:gmail.triage",
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

  return router;
}
