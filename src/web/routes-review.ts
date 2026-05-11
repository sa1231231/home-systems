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
import { TRIAGE_DOMAIN } from "../sync/email-triage.js";

const TriageCategoryEnum = z.enum(["noise", "worth_reading", "needs_reply"]);

const IdParam = z.coerce.number().int().positive();

const RejectBody = z.object({
  reason: z.string().max(2000).optional(),
});

const CorrectBody = z.object({
  category: TriageCategoryEnum,
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

  // Approve = "AI got it right." Always promote a rule keyed on the sender so
  // future matches skip the AI entirely.
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
      const result = await approveEntry(id, {
        promoteToRule: {
          name: defaultRuleNameFor(pending),
          match: defaultMatchFor(pending),
        },
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:needs-review.approve",
      });
      res.render("partials/_review-row", { entry: result.entry, applyOutcome: result.apply });
    } catch (err) {
      renderError(res, pending, err, id);
    }
  });

  // Skip = "don't decide right now." Marks the row reviewed (DB status
  // 'rejected') but creates no rule and applies no action. UI label is "Skip".
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

  // Correct = "AI picked the wrong category." User picks one of the three
  // categories; we build the corrected action via mapCategoryToAction and
  // promote a rule using that action so future matches skip the AI.
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
      const previousCategory =
        (pending.proposedAction as { category?: string } | null)?.category ?? "unknown";
      const decision = {
        category: body.category,
        reasoning: `user-corrected (was ${previousCategory})`,
      };
      const promoteToRule =
        pending.domain === TRIAGE_DOMAIN
          ? {
              name: defaultRuleNameFor(pending),
              match: defaultMatchFor(pending),
            }
          : undefined;
      const result = await correctEntry(id, {
        decision,
        promoteToRule,
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
