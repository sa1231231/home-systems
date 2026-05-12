import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { reverseOne } from "../changelog/undo.js";
import { groupBySession } from "./session-groups.js";

const SessionId = z.string().min(1).max(200);

/**
 * Roll back every reversible row in a session (status=success + not yet
 * undone), newest first. Returns the updated session-group row partial so
 * HTMX swaps the Undo button into a "all undone" pill.
 */
export function makeSessionsUiRouter(): Router {
  const router = Router();

  router.post("/:sessionId/rollback", async (req, res) => {
    let sessionId: string;
    try {
      sessionId = SessionId.parse(req.params.sessionId);
    } catch {
      res.status(400).send(`<tr><td colspan="5">invalid session id</td></tr>`);
      return;
    }
    try {
      const candidates = await db
        .select()
        .from(changelog)
        .where(
          and(
            eq(changelog.sessionId, sessionId),
            eq(changelog.status, "success"),
            isNull(changelog.undoneBy),
          ),
        )
        .orderBy(desc(changelog.id));
      const errors: Array<{ id: number; error: string }> = [];
      for (const row of candidates) {
        try {
          await reverseOne(row.id);
        } catch (err) {
          errors.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      // Re-fetch the whole session and re-render the group row.
      const refreshed = await db
        .select()
        .from(changelog)
        .where(eq(changelog.sessionId, sessionId))
        .orderBy(desc(changelog.id));
      const [group] = groupBySession(refreshed);
      if (!group) {
        res.send("");
        return;
      }
      res.render("partials/_session-group", { group, undoneNow: candidates.length - errors.length, errors });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res
        .status(500)
        .send(`<tr style="background:#fcf0f0;"><td colspan="5" style="color: var(--danger);">undo failed: ${msg}</td></tr>`);
    }
  });

  return router;
}
