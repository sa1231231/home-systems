import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { needsReview } from "../db/schema.js";
import { newSessionId } from "../changelog/index.js";
import { InvalidConditionError } from "../rules/dsl.js";
import {
  AlreadyDecidedError,
  EntryNotFoundError,
  approveEntry,
  correctEntry,
  rejectEntry,
} from "../needs-review/service.js";

const IdParam = z.coerce.number().int().positive();

const ApproveBody = z.object({
  promote_to_rule: z.union([z.literal("1"), z.literal("on"), z.literal("true")]).optional(),
  rule_name: z.string().min(1).max(200).optional(),
  rule_priority: z.coerce.number().int().min(0).max(10000).optional(),
});

const RejectBody = z.object({
  reason: z.string().max(2000).optional(),
});

const CorrectBody = z.object({
  decision: z.string().min(1),
});

function defaultRuleNameFor(entry: typeof needsReview.$inferSelect): string {
  const subj = (entry.subject ?? {}) as Record<string, unknown>;
  const from = typeof subj.from === "string" ? subj.from : "";
  if (from) return `auto: from=${from.slice(0, 80)}`;
  return `auto: review #${entry.id}`;
}

function defaultMatchFor(entry: typeof needsReview.$inferSelect): unknown {
  const subj = (entry.subject ?? {}) as Record<string, unknown>;
  if (typeof subj.from === "string" && subj.from) {
    return { op: "equals", field: "from", value: subj.from };
  }
  if (typeof subj.subject === "string" && subj.subject) {
    return { op: "equals", field: "subject", value: subj.subject };
  }
  return { op: "present", field: "from" };
}

async function loadEntry(id: number) {
  const [row] = await db.select().from(needsReview).where(eq(needsReview.id, id));
  return row;
}

function renderError(
  res: Parameters<Parameters<Router["post"]>[1]>[1],
  entry: typeof needsReview.$inferSelect | undefined,
  err: unknown,
  fallbackId: number,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    err instanceof EntryNotFoundError
      ? 404
      : err instanceof AlreadyDecidedError
        ? 409
        : err instanceof InvalidConditionError
          ? 400
          : 500;
  const safeEntry = entry ?? {
    id: fallbackId,
    createdAt: new Date(),
    subject: {},
    subjectKind: "",
    subjectId: "",
    proposedAction: null,
    status: "error",
  };
  res.status(status).render("partials/_review-row-error", { entry: safeEntry, error: message });
}

export function makeReviewUiRouter(): Router {
  const router = Router();

  router.post("/:id/approve", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    const pending = await loadEntry(id);
    if (!pending) {
      res.status(404).send("not found");
      return;
    }
    try {
      const body = ApproveBody.parse(req.body ?? {});
      const promoteToRule = body.promote_to_rule
        ? {
            name: body.rule_name ?? defaultRuleNameFor(pending),
            match: defaultMatchFor(pending),
            priority: body.rule_priority,
          }
        : undefined;
      const result = await approveEntry(id, {
        promoteToRule,
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:needs-review.approve",
      });
      res.render("partials/_review-row", { entry: result.entry, applyOutcome: result.apply });
    } catch (err) {
      renderError(res, pending, err, id);
    }
  });

  router.post("/:id/reject", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    const pending = await loadEntry(id);
    if (!pending) {
      res.status(404).send("not found");
      return;
    }
    try {
      const body = RejectBody.parse(req.body ?? {});
      const result = await rejectEntry(id, { reason: body.reason });
      res.render("partials/_review-row", { entry: result.entry, applyOutcome: null });
    } catch (err) {
      renderError(res, pending, err, id);
    }
  });

  router.post("/:id/correct", async (req, res) => {
    let id: number;
    try {
      id = IdParam.parse(req.params.id);
    } catch {
      res.status(400).send("invalid id");
      return;
    }
    const pending = await loadEntry(id);
    if (!pending) {
      res.status(404).send("not found");
      return;
    }
    try {
      const body = CorrectBody.parse(req.body ?? {});
      let decision: unknown;
      try {
        decision = JSON.parse(body.decision);
      } catch {
        throw new Error("decision must be valid JSON");
      }
      const result = await correctEntry(id, {
        decision,
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:needs-review.correct",
      });
      res.render("partials/_review-row", { entry: result.entry, applyOutcome: result.apply });
    } catch (err) {
      renderError(res, pending, err, id);
    }
  });

  return router;
}
