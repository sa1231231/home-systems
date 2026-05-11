import { Router } from "express";
import { z } from "zod";
import { RuleNotFoundError, toggleRuleEnabled } from "../rules/service.js";

const IdParam = z.coerce.number().int().positive();

export function makeRulesUiRouter(): Router {
  const router = Router();

  router.post("/:id/toggle", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    try {
      const rule = await toggleRuleEnabled(id);
      res.render("partials/_rule-row", { rule });
    } catch (err) {
      const status = err instanceof RuleNotFoundError ? 404 : 500;
      const message = err instanceof Error ? err.message : String(err);
      res.status(status).send(`<tr><td colspan="6" style="color: var(--danger);">${message}</td></tr>`);
    }
  });

  return router;
}
