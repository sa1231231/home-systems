import { Router } from "express";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";
import {
  hasGoogleCreds,
  getOAuthClient,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { runSync } from "../sync/contacts.js";
import { cronInfoForDomain } from "./cron-info.js";
import { findAuditIssues, type AuditReport, type DuplicateGroup } from "../sync/contacts-audit.js";
import {
  readContactsTab,
  getSheetIdByTitle,
  deleteDataRows,
  batchUpdateCells,
  colLetter,
  type CellUpdate,
} from "../integrations/google/sheets.js";
import { withChangelog } from "../changelog/index.js";
import { buildMergePlan, type MergePlan } from "../sync/contacts-merge.js";

const DOMAIN = "contact";

function sevenDaysAgo(now: Date = new Date()): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

export function makeContactsUiRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const since = sevenDaysAgo();
    const [rulesRows, pendingRows, activityRows] = await Promise.all([
      db
        .select()
        .from(rules)
        .where(and(eq(rules.domain, DOMAIN), eq(rules.enabled, true)))
        .orderBy(asc(rules.priority), desc(rules.id))
        .limit(200),
      db
        .select()
        .from(needsReview)
        .where(and(eq(needsReview.domain, DOMAIN), eq(needsReview.status, "pending")))
        .orderBy(desc(needsReview.id))
        .limit(200),
      db
        .select()
        .from(changelog)
        .where(and(eq(changelog.targetKind, "contact"), gte(changelog.createdAt, since)))
        .orderBy(desc(changelog.id))
        .limit(200),
    ]);
    type DupGroupView = DuplicateGroup & {
      rows: Array<{
        rowIndex: number;
        name: string;
        emails: string;
        phones: string;
        company: string;
      }>;
    };
    type AuditView = AuditReport & {
      totalRows: number;
      emailDupViews: DupGroupView[];
      phoneDupViews: DupGroupView[];
    };
    type RowPreview = {
      rowIndex: number;
      name: string;
      emails: string;
      phones: string;
      company: string;
    };
    type MergePreview = {
      keeperRowIndex: number;
      deleteRowIndices: number[];
      updates: Array<{ col: string; from: string; to: string }>;
    };
    let audit: AuditView | null = null;
    let sheetUrl: string | null = null;
    const matchedRowsByEntryId: Record<number, RowPreview[]> = {};
    const mergePreviewByEntryId: Record<number, MergePreview | null> = {};
    if (hasGoogleCreds()) {
      try {
        const creds = requireGoogleCreds();
        sheetUrl = `https://docs.google.com/spreadsheets/d/${creds.sheetId}/edit`;
        const tab = await readContactsTab(getOAuthClient(), creds.sheetId);
        const records = tab.rows.map((r) => r.record);
        const report = findAuditIssues(records);
        const rowView = (rowIndex: number): RowPreview => {
          const r = records[rowIndex] ?? {};
          const first = (r.first_name ?? "").trim();
          const last = (r.last_name ?? "").trim();
          const full = (r.full_name ?? "").trim();
          return {
            rowIndex,
            name: full || `${first} ${last}`.trim() || "(no name)",
            emails: (r.emails || r.email || "").trim(),
            phones: (r.phones || r.phone || "").trim(),
            company: (r.company || "").trim(),
          };
        };
        const emailDupViews: DupGroupView[] = report.emailDuplicates
          .slice(0, 50)
          .map((g) => ({ ...g, rows: g.rowIndices.map(rowView) }));
        const phoneDupViews: DupGroupView[] = report.phoneDuplicates
          .slice(0, 50)
          .map((g) => ({ ...g, rows: g.rowIndices.map(rowView) }));
        audit = { ...report, totalRows: tab.rows.length, emailDupViews, phoneDupViews };

        // For ambiguous pending reviews, attach the matched sheet rows + a
        // pre-computed merge preview so the UI can render both inline. The
        // preview is what the user would get if they clicked Apply merge.
        for (const entry of pendingRows) {
          if (entry.subjectKind !== "google_contact_ambiguous") continue;
          const action = entry.proposedAction as { matches?: number[] } | null;
          const matches = Array.isArray(action?.matches) ? action!.matches : [];
          if (matches.length > 0) {
            matchedRowsByEntryId[entry.id] = matches.map(rowView);
            const matchedFull = matches
              .map((i) => (records[i] ? { rowIndex: i, record: records[i] } : null))
              .filter((x): x is { rowIndex: number; record: Record<string, string> } => x !== null);
            if (matchedFull.length >= 2) {
              try {
                const plan: MergePlan = buildMergePlan(matchedFull, tab.headers);
                mergePreviewByEntryId[entry.id] = {
                  keeperRowIndex: plan.keeperRowIndex,
                  deleteRowIndices: plan.deleteRowIndices,
                  updates: plan.updates,
                };
              } catch {
                mergePreviewByEntryId[entry.id] = null;
              }
            }
          }
        }
      } catch {
        audit = null;
      }
    }
    res.render("contacts", {
      rules: rulesRows,
      pending: pendingRows,
      activity: activityRows,
      flash: null,
      cron: cronInfoForDomain("contact"),
      audit,
      sheetUrl,
      matchedRowsByEntryId,
      mergePreviewByEntryId,
    });
  });

  const DeleteOrphanParams = z.coerce.number().int().min(0).max(100_000);

  router.post("/delete-orphan/:rowIndex", async (req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(`<tr><td colspan="5" class="muted">Google credentials not configured.</td></tr>`);
      return;
    }
    let rowIndex: number;
    try {
      rowIndex = DeleteOrphanParams.parse(req.params.rowIndex);
    } catch {
      res.status(400).send("invalid row");
      return;
    }
    try {
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tab = await readContactsTab(client, creds.sheetId);
      if (rowIndex >= tab.rows.length) {
        res
          .status(404)
          .send(
            `<tr><td colspan="5" class="muted">Row ${rowIndex} no longer exists (sheet shifted? reload the page).</td></tr>`,
          );
        return;
      }
      const record = tab.rows[rowIndex].record;
      const sheetId = await getSheetIdByTitle(client, creds.sheetId, tab.tab);
      await withChangelog(
        {
          caller: "ui:contacts.audit.delete-orphan",
          sessionId: req.sessionId,
          operation: "contacts.audit.delete_row",
          targetKind: "contact_row",
          targetId: `${tab.tab}!row${rowIndex}`,
          intent: "ui audit cleanup",
          before: { row_index: rowIndex, tab: tab.tab, record },
          after: { deleted: true },
          externalTarget: `google.sheet:${creds.sheetId}!${tab.tab}!row${rowIndex}`,
        },
        async () => {
          await deleteDataRows(client, creds.sheetId, sheetId, [rowIndex]);
        },
      );
      // Empty body → HTMX outerHTML swap removes the row.
      res.status(200).send("");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res
        .status(500)
        .send(`<tr style="background:#fcf0f0;"><td colspan="5" style="color: var(--danger);">${msg}</td></tr>`);
    }
  });

  router.post("/sync", async (_req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const creds = requireGoogleCreds();
      const result = await runSync(getOAuthClient(), creds.sheetId, { dryRun: false });
      res.setHeader("HX-Refresh", "true");
      const s = result.summary;
      const q = result.queued;
      if (q) {
        res.send(
          `<div class="flash ok">Queued for review: ${q.queued_inserts} insert${q.queued_inserts === 1 ? '' : 's'}, ${q.queued_refreshes} refresh${q.queued_refreshes === 1 ? '' : 'es'}, ${q.queued_ambiguous} ambiguous (${q.skipped_duplicates} already pending). ${s.unchanged} unchanged.</div>`,
        );
      } else {
        res.send(
          `<div class="flash ok">Sync done: inserted=${s.inserted} refreshed=${s.refreshed} unchanged=${s.unchanged} ambiguous=${s.ambiguous}</div>`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .send(
          `<div class="flash err">Sync failed: ${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
        );
    }
  });

  // Merge action for ambiguous contact-domain reviews. Reads the matched
  // sheet rows, picks the lowest-index row as keeper, unions emails/phones/
  // groups/tags, picks the longest name/company/etc. across all rows,
  // concats legacy_notes, then deletes the non-keeper rows.
  router.post("/merge-review/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).send("invalid review id");
      return;
    }
    if (!hasGoogleCreds()) {
      res.status(503).send(`<tr><td colspan="5" class="muted">Google credentials not configured.</td></tr>`);
      return;
    }
    const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
    if (!entry) {
      res.status(404).send("not found");
      return;
    }
    if (entry.status !== "pending") {
      res.status(409).send("already decided");
      return;
    }
    if (entry.domain !== "contact" || entry.subjectKind !== "google_contact_ambiguous") {
      res.status(400).send("merge only applies to ambiguous contact reviews");
      return;
    }
    const action = entry.proposedAction as { matches?: number[]; tab?: string } | null;
    const matches = Array.isArray(action?.matches) ? action!.matches : [];
    if (matches.length < 2) {
      res.status(400).send("merge requires ≥ 2 matched rows");
      return;
    }
    try {
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tab = await readContactsTab(client, creds.sheetId);
      const matchedRows = matches
        .map((rowIndex) => {
          const r = tab.rows[rowIndex];
          return r ? { rowIndex, record: r.record } : null;
        })
        .filter((x): x is { rowIndex: number; record: Record<string, string> } => x !== null);
      if (matchedRows.length < 2) {
        res.status(409).send("one or more matched rows no longer exist (sheet shifted? re-sync first)");
        return;
      }
      const plan = buildMergePlan(matchedRows, tab.headers);
      const sheetId = await getSheetIdByTitle(client, creds.sheetId, tab.tab);
      const keeperSheetRow = plan.keeperRowIndex + 2; // +1 1-based, +1 header
      const cellUpdates: CellUpdate[] = plan.updates.map((u) => ({
        range: `${tab.tab}!${colLetter(tab.headers.indexOf(u.col))}${keeperSheetRow}`,
        value: u.to,
      }));
      await withChangelog(
        {
          caller: "ui:contacts.merge-review",
          sessionId: req.sessionId,
          operation: "contacts.merge_review",
          targetKind: "contact_row",
          targetId: `${tab.tab}!row${plan.keeperRowIndex}`,
          intent: `merge ${matchedRows.length} rows for review #${id}`,
          before: {
            review_id: id,
            keeper_row_index: plan.keeperRowIndex,
            delete_row_indices: plan.deleteRowIndices,
            rows: plan.beforeRows,
          },
          after: {
            keeper_row_index: plan.keeperRowIndex,
            deleted_count: plan.deleteRowIndices.length,
            updates: plan.updates,
          },
          externalTarget: `google.sheet:${creds.sheetId}!${tab.tab}`,
        },
        async () => {
          if (cellUpdates.length > 0) {
            await batchUpdateCells(client, creds.sheetId, cellUpdates);
          }
          if (plan.deleteRowIndices.length > 0) {
            await deleteDataRows(client, creds.sheetId, sheetId, plan.deleteRowIndices);
          }
        },
      );
      // Close out the needs_review row as approved.
      await db
        .update(needsReview)
        .set({
          status: "approved",
          decision: {
            merged: true,
            keeperRowIndex: plan.keeperRowIndex,
            deletedRowIndices: plan.deleteRowIndices,
            updates: plan.updates.length,
          } as never,
          decidedAt: new Date(),
          decidedBy: "ui",
          updatedAt: new Date(),
        })
        .where(eq(needsReview.id, id));
      const [updated] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      res.render("partials/_contact-review-row", {
        entry: updated,
        applyOutcome: { applied: true, apply_result: { merged: true, kept: plan.keeperRowIndex, deleted: plan.deleteRowIndices } },
        matchedRows: null,
      });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res
        .status(500)
        .send(`<tr style="background:#fcf0f0;"><td colspan="5" style="color: var(--danger);">merge failed: ${msg}</td></tr>`);
    }
  });

  return router;
}
