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
import { getDomainConfig, UnknownDomainError } from "../needs-review/domains.js";

const IdParam = z.coerce.number().int().positive();

function partialFor(domain: string): string {
  if (domain === "transaction") return "partials/_transaction-review-row";
  if (domain === "contact") return "partials/_contact-review-row";
  return "partials/_review-row";
}

const RejectBody = z.object({
  reason: z.string().max(2000).optional(),
});

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
          : err instanceof UnknownDomainError
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

  // Approve = "AI got it right." Always promote a rule via the domain's default
  // match/name so future identical inputs skip the AI entirely.
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
      const cfg = getDomainConfig(pending.domain);
      const result = await approveEntry(id, {
        promoteToRule:
          cfg.promotesOnApprove === false
            ? undefined
            : {
                name: cfg.defaultRuleName(pending),
                match: cfg.defaultMatch(pending),
              },
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:needs-review.approve",
      });
      res.render(partialFor(result.entry.domain), {
        entry: result.entry,
        applyOutcome: result.apply,
        includeBulkCheckbox: true,
      });
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
      res.render(partialFor(result.entry.domain), {
        entry: result.entry,
        applyOutcome: null,
        includeBulkCheckbox: true,
      });
    } catch (err) {
      renderError(res, pending, err, id);
    }
  });

  // Bulk approve/skip. Takes ids[] from a multi-select form. Calls the same
  // per-entry handlers; on success triggers HX-Refresh so the queue reloads.
  // Already-decided entries are skipped silently (they don't block the batch).
  const BulkBody = z.object({
    ids: z.union([
      z.array(z.coerce.number().int().positive()).max(500),
      z.coerce.number().int().positive(),
    ]),
  });
  function normalizeIds(parsed: z.infer<typeof BulkBody>): number[] {
    return Array.isArray(parsed.ids) ? parsed.ids : [parsed.ids];
  }

  router.post("/bulk/approve", async (req, res) => {
    let ids: number[];
    try {
      ids = normalizeIds(BulkBody.parse(req.body ?? {}));
    } catch {
      res.status(400).send(`<div class="flash err">Invalid request.</div>`);
      return;
    }
    let approved = 0;
    let skipped = 0;
    const failures: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      const entry = await loadEntry(id);
      if (!entry) {
        failures.push({ id, error: "not found" });
        continue;
      }
      try {
        const cfg = getDomainConfig(entry.domain);
        await approveEntry(id, {
          promoteToRule:
            cfg.promotesOnApprove === false
              ? undefined
              : { name: cfg.defaultRuleName(entry), match: cfg.defaultMatch(entry) },
          sessionId: req.sessionId ?? newSessionId(),
          caller: "ui:needs-review.bulk-approve",
        });
        approved++;
      } catch (err) {
        if (err instanceof AlreadyDecidedError) {
          skipped++;
        } else {
          failures.push({ id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    res.setHeader("HX-Refresh", "true");
    const failNote = failures.length > 0 ? ` ${failures.length} failed.` : "";
    res.send(
      `<div class="flash ok">Bulk approve: ${approved} done, ${skipped} already-decided.${failNote}</div>`,
    );
  });

  router.post("/bulk/reject", async (req, res) => {
    let ids: number[];
    try {
      ids = normalizeIds(BulkBody.parse(req.body ?? {}));
    } catch {
      res.status(400).send(`<div class="flash err">Invalid request.</div>`);
      return;
    }
    let rejected = 0;
    let skipped = 0;
    for (const id of ids) {
      const entry = await loadEntry(id);
      if (!entry) continue;
      try {
        await rejectEntry(id, { reason: "bulk skip" });
        rejected++;
      } catch (err) {
        if (err instanceof AlreadyDecidedError) skipped++;
      }
    }
    res.setHeader("HX-Refresh", "true");
    res.send(
      `<div class="flash ok">Bulk skip: ${rejected} done, ${skipped} already-decided.</div>`,
    );
  });

  // Correct = "AI picked the wrong category." User picks the right one (validated
  // against the domain's enum), and we promote a rule using the *corrected* action.
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
      const cfg = getDomainConfig(pending.domain);
      if (cfg.supportsCorrect === false) {
        res
          .status(400)
          .send(
            `<tr><td colspan="5" class="muted">Correct isn't supported for the '${pending.domain}' domain. Approve or skip.</td></tr>`,
          );
        return;
      }
      const body = cfg.validateCorrection(req.body ?? {});
      const previousCategory =
        (pending.proposedAction as { category?: string } | null)?.category ?? "unknown";
      const decision = cfg.buildCorrectedDecision(body.category, previousCategory);
      const result = await correctEntry(id, {
        decision,
        promoteToRule: {
          name: cfg.defaultRuleName(pending),
          match: cfg.defaultMatch(pending),
        },
        sessionId: req.sessionId ?? newSessionId(),
        caller: "ui:needs-review.correct",
      });
      res.render(partialFor(result.entry.domain), {
        entry: result.entry,
        applyOutcome: result.apply,
        includeBulkCheckbox: true,
      });
    } catch (err) {
      renderError(res, pending, err, id);
    }
  });

  return router;
}
