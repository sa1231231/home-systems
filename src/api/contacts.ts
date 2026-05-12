import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getOAuthClient, MissingGoogleCredsError, requireGoogleCreds } from "../integrations/google/oauth.js";
import { listConnections } from "../integrations/google/people.js";
import { previewSheet } from "../integrations/google/sheets.js";
import { runSync, type SyncPlan } from "../sync/contacts.js";
import { runDedupe } from "../sync/dedupe-runner.js";
import type { DedupePlan } from "../sync/dedupe.js";
import {
  addToCsvField,
  ContactNotFoundError,
  removeFromCsvField,
  setBoolField,
  UnknownColumnError,
} from "../sync/contact-writes.js";
import { DailyLimitExceededError } from "../safety/limits.js";
import { findAuditIssues } from "../sync/contacts-audit.js";
import {
  readContactsTab,
  getSheetIdByTitle,
  deleteDataRows,
  deleteColumns,
} from "../integrations/google/sheets.js";
import { withChangelog } from "../changelog/index.js";

const PreviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const SyncQuery = z.object({
  verbose: z.coerce.boolean().default(false),
});

const ResourceName = z.string().regex(/^people\/[A-Za-z0-9_-]+$/, "must look like 'people/c123…'");
const NonEmptyString = z.string().trim().min(1).max(200);

const CsvOpBody = z.object({
  resource_name: ResourceName,
  values: z.array(NonEmptyString).min(1).max(20),
});

const BoolOpBody = z.object({
  resource_name: ResourceName,
  value: z.boolean(),
});

// 60 write operations per minute per IP. Catches runaway loops without
// constraining intentional bulk operations from a careful caller.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate limit exceeded — wait a minute and retry" },
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

  router.get("/audit", async (_req, res) => {
    try {
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tab = await readContactsTab(client, creds.sheetId);
      const records = tab.rows.map((r) => r.record);
      const report = findAuditIssues(records);
      res.json({ ok: true, total_rows: tab.rows.length, ...report });
    } catch (err) {
      handleError(err, res);
    }
  });

  const DeleteRowBody = z.object({
    row_index: z.coerce.number().int().min(0).max(100_000),
    expected_full_name: z.string().max(500).optional(),
  });

  const CleanupColumnsBody = z.object({
    columns: z.array(z.string().min(1).max(200)).min(1).max(50),
    dry_run: z.boolean().default(false),
  });

  router.post("/sheet/cleanup-columns", writeLimiter, async (req, res) => {
    try {
      const { columns, dry_run } = CleanupColumnsBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tab = await readContactsTab(client, creds.sheetId);
      const matched: { name: string; index: number }[] = [];
      const missing: string[] = [];
      for (const name of columns) {
        const idx = tab.headers.indexOf(name);
        if (idx === -1) missing.push(name);
        else matched.push({ name, index: idx });
      }
      if (dry_run) {
        res.json({ ok: true, dry_run: true, would_delete: matched, missing });
        return;
      }
      if (matched.length === 0) {
        res.json({ ok: true, dry_run: false, deleted: [], missing });
        return;
      }
      const sheetId = await getSheetIdByTitle(client, creds.sheetId, tab.tab);
      await withChangelog(
        {
          caller: "api:contacts.sheet.cleanup-columns",
          sessionId: req.sessionId,
          operation: "contacts.sheet.cleanup_columns",
          targetKind: "contact_sheet",
          targetId: `${tab.tab}!cols`,
          intent: `drop columns: ${matched.map((m) => m.name).join(", ")}`,
          before: { headers: tab.headers },
          after: { dropped: matched.map((m) => m.name) },
          externalTarget: `google.sheet:${creds.sheetId}!${tab.tab}!cols`,
        },
        async () => {
          await deleteColumns(
            client,
            creds.sheetId,
            sheetId,
            matched.map((m) => m.index),
          );
        },
      );
      res.json({ ok: true, dry_run: false, deleted: matched, missing });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/audit/delete-row", writeLimiter, async (req, res) => {
    try {
      const { row_index, expected_full_name } = DeleteRowBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tab = await readContactsTab(client, creds.sheetId);
      if (row_index >= tab.rows.length) {
        res.status(404).json({
          ok: false,
          error: `row ${row_index} not found (sheet has ${tab.rows.length} rows)`,
        });
        return;
      }
      const record = tab.rows[row_index].record;
      if (
        expected_full_name !== undefined &&
        (record.full_name ?? "").trim() !== expected_full_name.trim()
      ) {
        res.status(409).json({
          ok: false,
          error: "row contents changed since you loaded the page",
          actual_full_name: record.full_name ?? "",
          expected_full_name,
        });
        return;
      }
      const sheetId = await getSheetIdByTitle(client, creds.sheetId, tab.tab);
      await withChangelog(
        {
          caller: "api:contacts.audit.delete-row",
          sessionId: req.sessionId,
          operation: "contacts.audit.delete_row",
          targetKind: "contact_row",
          targetId: `${tab.tab}!row${row_index}`,
          intent: `audit cleanup: drop orphan row ${row_index}`,
          before: { row_index, tab: tab.tab, record },
          after: { deleted: true },
          externalTarget: `google.sheet:${creds.sheetId}!${tab.tab}!row${row_index}`,
        },
        async () => {
          await deleteDataRows(client, creds.sheetId, sheetId, [row_index]);
        },
      );
      res.json({
        ok: true,
        deleted_row_index: row_index,
        full_name: record.full_name ?? "",
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  // --- Narrow per-contact write endpoints (1b-γ) -----------------------
  router.post("/add-groups", writeLimiter, async (req, res) => {
    try {
      const { resource_name, values } = CsvOpBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await addToCsvField(client, creds.sheetId, resource_name, "groups", values, {
        sessionId: req.sessionId,
        caller: "api:contacts.add-groups",
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/remove-groups", writeLimiter, async (req, res) => {
    try {
      const { resource_name, values } = CsvOpBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await removeFromCsvField(client, creds.sheetId, resource_name, "groups", values, {
        sessionId: req.sessionId,
        caller: "api:contacts.remove-groups",
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/add-tags", writeLimiter, async (req, res) => {
    try {
      const { resource_name, values } = CsvOpBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await addToCsvField(client, creds.sheetId, resource_name, "tags", values, {
        sessionId: req.sessionId,
        caller: "api:contacts.add-tags",
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/remove-tags", writeLimiter, async (req, res) => {
    try {
      const { resource_name, values } = CsvOpBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await removeFromCsvField(client, creds.sheetId, resource_name, "tags", values, {
        sessionId: req.sessionId,
        caller: "api:contacts.remove-tags",
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/set-archived", writeLimiter, async (req, res) => {
    try {
      const { resource_name, value } = BoolOpBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await setBoolField(client, creds.sheetId, resource_name, "is_archived", value, {
        sessionId: req.sessionId,
        caller: "api:contacts.set-archived",
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/set-starred", writeLimiter, async (req, res) => {
    try {
      const { resource_name, value } = BoolOpBody.parse(req.body);
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const result = await setBoolField(client, creds.sheetId, resource_name, "starred", value, {
        sessionId: req.sessionId,
        caller: "api:contacts.set-starred",
      });
      res.json({ ok: true, ...result });
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
  if (err instanceof ContactNotFoundError) {
    res.status(404).json({ ok: false, error: err.message, resource_name: err.resourceName });
    return;
  }
  if (err instanceof UnknownColumnError) {
    res.status(409).json({ ok: false, error: err.message, column: err.column });
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
