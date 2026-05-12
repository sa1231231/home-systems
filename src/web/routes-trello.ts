import { Router } from "express";
import { and, desc, gte, like } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { newSessionId } from "../changelog/index.js";
import { windowStartFor24h } from "../api/changes.js";
import {
  hasTrelloCreds,
  MissingTrelloCredsError,
  requireTrelloCreds,
} from "../integrations/trello/auth.js";
import { makeTrelloClient } from "../integrations/trello/client.js";
import { runTrelloReorderOnce } from "../sync/trello-runner.js";
import { cronInfoForDomain } from "./cron-info.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";

export function makeTrelloUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!hasTrelloCreds()) {
      res.render("trello", {
        notConfigured: true,
        flash: null,
        activity: [],
        cron: cronInfoForDomain("trello"),
        run: null,
      });
      return;
    }
    const since = windowStartFor24h();
    const [activity, run] = await Promise.all([
      db
        .select()
        .from(changelog)
        .where(and(like(changelog.operation, "trello.%"), gte(changelog.createdAt, since)))
        .orderBy(desc(changelog.id))
        .limit(50),
      latestRunFor("trello"),
    ]);
    res.render("trello", {
      notConfigured: false,
      flash: null,
      activity,
      cron: cronInfoForDomain("trello"),
      run,
    });
  });

  router.get("/triage-status", async (req, res) => {
    const polling = req.query.polling === "1";
    const run = await latestRunFor("trello");
    if (polling && run && run.status !== "running") {
      const completedMs = run.completedAt ? new Date(run.completedAt).getTime() : 0;
      if (completedMs && Date.now() - completedMs <= 60_000) {
        res.setHeader("HX-Refresh", "true");
        res.send("");
        return;
      }
    }
    res.render("partials/_triage-status", { run, statusUrl: "/ui/trello/triage-status" });
  });

  router.post("/reorder", async (req, res) => {
    if (!hasTrelloCreds()) {
      res.status(503).send(`<div class="flash err">Trello credentials not configured.</div>`);
      return;
    }
    try {
      const creds = requireTrelloCreds();
      const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
      const sessionId = req.sessionId ?? newSessionId();
      const result = await withTriageRun("trello", sessionId, "ui:trello.reorder", () =>
        runTrelloReorderOnce(client, creds, {
          dryRun: false,
          sessionId,
          caller: "ui:trello.reorder",
        }),
      );
      const errs = result.errors.length;
      res.setHeader("HX-Refresh", "true");
      const kind = errs > 0 ? "err" : "ok";
      res.send(
        `<div class="flash ${kind}">Reorder: ${result.moved} moved, ${result.reordered} reordered, ${result.unchanged} unchanged${errs ? `, ${errs} errors` : ""}.</div>`,
      );
    } catch (err) {
      const status = err instanceof MissingTrelloCredsError ? 503 : 500;
      const message = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res.status(status).send(`<div class="flash err">Reorder failed: ${message}</div>`);
    }
  });

  return router;
}
