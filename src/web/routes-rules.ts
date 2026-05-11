import { Router } from "express";
import { z } from "zod";
import { deleteRule, RuleNotFoundError } from "../rules/service.js";

const IdParam = z.coerce.number().int().positive();

export function makeRulesUiRouter(): Router {
  const router = Router();

  router.post("/:id/delete", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    try {
      await deleteRule(id);
      // HTMX swap will replace the <tr> with this empty response → row disappears.
      res.status(200).send("");
    } catch (err) {
      const status = err instanceof RuleNotFoundError ? 404 : 500;
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(status)
        .send(`<tr><td colspan="7" style="color: var(--danger);">${message}</td></tr>`);
    }
  });

  return router;
}
