import { Router } from "express";
import { z } from "zod";
import { getOAuthClient, MissingGoogleCredsError, requireGoogleCreds } from "../integrations/google/oauth.js";
import { listConnections } from "../integrations/google/people.js";
import { previewSheet } from "../integrations/google/sheets.js";

const PreviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function makeContactsRouter(): Router {
  const router = Router();

  router.get("/google/preview", async (req, res) => {
    try {
      const { limit } = PreviewQuery.parse(req.query);
      const client = getOAuthClient();
      const people = await listConnections(client, { pageSize: limit });
      res.json({ ok: true, count: people.length, people });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/sheet/preview", async (req, res) => {
    try {
      const { limit } = PreviewQuery.parse(req.query);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const preview = await previewSheet(client, creds.sheetId, { limit });
      res.json({ ok: true, ...preview, count: preview.rows.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Parameters<Parameters<Router["get"]>[1]>[1]): void {
  if (err instanceof MissingGoogleCredsError) {
    res.status(503).json({ ok: false, error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "invalid query", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
