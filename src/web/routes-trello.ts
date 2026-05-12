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

export function makeTrelloUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!hasTrelloCreds()) {
      res.render("trello", {
        notConfigured: true,
        flash: null,
        activity: [],
        cron: cronInfoForDomain("trello"),
      });
      return;
    }
    const since = windowStartFor24h();
    const activity = await db
      .select()
      .from(changelog)
      .where(and(like(changelog.operation, "trello.%"), gte(changelog.createdAt, since)))
      .orderBy(desc(changelog.id))
      .limit(50);
    res.render("trello", {
      notConfigured: false,
      flash: null,
      activity,
      cron: cronInfoForDomain("trello"),
    });
  });

  router.post("/reorder", async (req, res) => {
    if (!hasTrelloCreds()) {
      res.status(503).send(`<div class="flash err">Trello credentials not configured.</div>`);
      return;
    }
    try {
      const creds = requireTrelloCreds();
      const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
      const result = await runTrelloReorderOnce(client, creds, {
        dryRun: false,
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:trello.reorder",
      });
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
