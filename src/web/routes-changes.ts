import { Router } from "express";
import { desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { windowStartFor24h } from "../api/changes.js";
import {
  EntryNotFoundError,
  NotReversibleError,
  reverseOne,
} from "../changelog/undo.js";
import { NoReverserError } from "../changelog/index.js";

const IdParam = z.coerce.number().int().positive();

export function makeChangesUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const since = windowStartFor24h();
    const rows = await db
      .select()
      .from(changelog)
      .where(gte(changelog.createdAt, since))
      .orderBy(desc(changelog.id))
      .limit(500);
    res.render("changes", {
      since: since.toISOString(),
      rows,
      flash: null,
    });
  });

  router.post("/:id/undo", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    const [row] = await db.select().from(changelog).where(eq(changelog.id, id)).limit(1);
    if (!row) {
      res.status(404).send("not found");
      return;
    }
    try {
      await reverseOne(id);
      const [updated] = await db
        .select()
        .from(changelog)
        .where(eq(changelog.id, id))
        .limit(1);
      res.render("partials/_change-row", { row: updated ?? row });
    } catch (err) {
      res.status(statusForUndoError(err)).render("partials/_change-row-error", {
        row,
        error: formatUndoError(err),
      });
    }
  });

  return router;
}

function statusForUndoError(err: unknown): number {
  if (err instanceof EntryNotFoundError) return 404;
  if (err instanceof NotReversibleError) return 409;
  if (err instanceof NoReverserError) return 409;
  return 500;
}

function formatUndoError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
