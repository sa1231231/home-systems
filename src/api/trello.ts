import { Router } from "express";
import { z } from "zod";
import { newSessionId } from "../changelog/index.js";
import {
  MissingTrelloCredsError,
  requireTrelloAuth,
  requireTrelloCreds,
} from "../integrations/trello/auth.js";
import { makeTrelloClient, trelloGetRaw } from "../integrations/trello/client.js";
import { runTrelloReorderOnce } from "../sync/trello-runner.js";
import { DailyLimitExceededError } from "../safety/limits.js";

const TriggerQuery = z.object({
  dry_run: z.coerce.boolean().default(false),
});

export function makeTrelloRouter(): Router {
  const router = Router();

  /**
   * Discovery endpoint: lists every board the configured token can see,
   * along with each board's open lists and labels. Only requires
   * TRELLO_API_KEY + TRELLO_TOKEN (not the board/list IDs). Used to find
   * IDs to populate the remaining env vars without running scripts locally.
   */
  router.get("/discover", async (_req, res) => {
    try {
      const auth = requireTrelloAuth();
      const client = makeTrelloClient(auth);
      const boards = await client.listMemberBoards();
      const orgs = (await trelloGetRaw(auth, "/members/me/organizations", {
        fields: "displayName,name",
      })) as Array<{ id: string; displayName: string; name: string }>;
      const detailed = await Promise.all(
        boards.map(async (b) => {
          const [lists, labels, customFields] = await Promise.all([
            client.getLists(b.id),
            client.getLabels(b.id),
            trelloGetRaw(auth, `/boards/${b.id}/customFields`).catch(() => []),
          ]);
          const cfields = (customFields as Array<{
            id: string;
            name: string;
            type: string;
            options?: Array<{ id: string; value?: { text?: string } }>;
          }>).map((cf) => ({
            id: cf.id,
            name: cf.name,
            type: cf.type,
            options: (cf.options ?? []).map((o) => ({
              id: o.id,
              value: o.value?.text ?? null,
            })),
          }));
          return {
            id: b.id,
            name: b.name,
            closed: (b as { closed?: boolean }).closed ?? false,
            lists: lists.map((l) => ({ id: l.id, name: l.name })),
            labels: labels.map((l) => ({
              id: l.id,
              name: l.name || null,
              color: l.color,
            })),
            custom_fields: cfields,
          };
        }),
      );
      res.json({ ok: true, organizations: orgs, count: detailed.length, boards: detailed });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/today", async (req, res) => {
    try {
      const creds = requireTrelloCreds();
      const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
      const result = await runTrelloReorderOnce(client, creds, {
        dryRun: true,
        sessionId: req.sessionId ?? newSessionId(),
        caller: "api:trello.today",
      });
      res.json({ ok: true, dry_run: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/reorder", async (req, res) => {
    try {
      const { dry_run } = TriggerQuery.parse(req.query);
      const creds = requireTrelloCreds();
      const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
      const result = await runTrelloReorderOnce(client, creds, {
        dryRun: dry_run,
        sessionId: req.sessionId ?? newSessionId(),
        caller: dry_run ? "api:trello.reorder:dry-run" : "api:trello.reorder",
      });
      res.json({ ok: true, dry_run, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  if (err instanceof MissingTrelloCredsError) {
    res.status(503).json({ ok: false, error: err.message });
    return;
  }
  if (err instanceof DailyLimitExceededError) {
    res.status(429).json({
      ok: false,
      error: err.message,
      operation: err.operation,
      count: err.count,
      limit: err.limit,
      day: err.day,
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "invalid request", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
