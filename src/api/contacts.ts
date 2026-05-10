import { Router } from "express";
import { z } from "zod";
import { getOAuthClient, MissingGoogleCredsError, requireGoogleCreds } from "../integrations/google/oauth.js";
import { listConnections } from "../integrations/google/people.js";
import { previewSheet } from "../integrations/google/sheets.js";
import { runSync, type SyncPlan } from "../sync/contacts.js";
import { runDedupe } from "../sync/dedupe-runner.js";
import type { DedupePlan } from "../sync/dedupe.js";

const PreviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SyncQuery = z.object({
  verbose: z.coerce.boolean().default(false),
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

  router.get("/sync/plan", async (req, res) => {
    try {
      const { verbose } = SyncQuery.parse(req.query);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await runSync(client, creds.sheetId, { dryRun: true });
      res.json({ ok: true, dry_run: true, summary: result.summary, ...renderPlan(result.plan, verbose) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/sync", async (req, res) => {
    try {
      const { verbose } = SyncQuery.parse(req.query);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await runSync(client, creds.sheetId, { dryRun: false });
      res.json({ ok: true, applied: true, summary: result.summary, ...renderPlan(result.plan, verbose) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/dedupe/plan", async (req, res) => {
    try {
      const { verbose } = SyncQuery.parse(req.query);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await runDedupe(client, creds.sheetId, { dryRun: true });
      res.json({ ok: true, dry_run: true, summary: result.summary, ...renderDedupe(result.plan, verbose) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/dedupe", async (req, res) => {
    try {
      const { verbose } = SyncQuery.parse(req.query);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await runDedupe(client, creds.sheetId, { dryRun: false });
      res.json({ ok: true, applied: true, summary: result.summary, ...renderDedupe(result.plan, verbose) });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function renderDedupe(plan: DedupePlan, verbose: boolean): Record<string, unknown> {
  const merges = plan.merges.map((m) => ({
    canonical_row_index: m.canonicalRowIndex,
    duplicate_row_indices: m.duplicateRowIndices,
    fields_filled: Object.keys(m.fills),
    shared_emails: m.sharedEmails,
    shared_phones: m.sharedPhones,
  }));
  const out: Record<string, unknown> = { merges, rows_to_delete: plan.rowsToDelete };
  if (verbose) {
    out.merges_full = plan.merges.map((m) => ({
      canonical_row_index: m.canonicalRowIndex,
      duplicate_row_indices: m.duplicateRowIndices,
      fills: m.fills,
      shared_emails: m.sharedEmails,
      shared_phones: m.sharedPhones,
    }));
  }
  return out;
}

function renderPlan(plan: SyncPlan, verbose: boolean): Record<string, unknown> {
  const ambiguous = plan.ambiguous.map((a) => ({
    resource_name: a.person.resource_name,
    display_name: a.person.display_name,
    matched_row_indices: a.matches,
    via: a.via,
  }));
  const inserts = plan.inserts.map((i) => ({
    resource_name: i.person.resource_name,
    display_name: i.person.display_name,
    primary_email: i.person.emails[0] ?? null,
    primary_phone: i.person.phones[0] ?? null,
  }));
  const refreshes_summary = plan.refreshes.map((r) => ({
    resource_name: r.person.resource_name,
    display_name: r.person.display_name,
    row_index: r.rowIndex,
    via: r.via,
    fields_changed: r.updates.map((u) => u.col),
  }));
  const out: Record<string, unknown> = {
    needs_header_update: plan.needsHeaderUpdate,
    inserts,
    refreshes: refreshes_summary,
    ambiguous,
  };
  if (verbose) {
    out.refreshes_full = plan.refreshes.map((r) => ({
      resource_name: r.person.resource_name,
      row_index: r.rowIndex,
      updates: r.updates,
    }));
  }
  return out;
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
