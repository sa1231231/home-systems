import { Router } from "express";
import { and, asc, desc, eq, gte, like, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";
import { getConfig } from "../config.js";
import {
  hasGoogleCreds,
  getOAuthClient,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { runSync } from "../sync/contacts.js";
import { cronInfoForDomain } from "./cron-info.js";
import {
  findAuditIssues,
  emailsInRow,
  phonesInRow,
  type AuditReport,
  type DuplicateGroup,
} from "../sync/contacts-audit.js";
import { groupBySession } from "./session-groups.js";
import {
  readContactsTab,
  getSheetIdByTitle,
  deleteDataRows,
  batchUpdateCells,
  colLetter,
  type CellUpdate,
} from "../integrations/google/sheets.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import { listGroups } from "../sync/contact-groups.js";
import { withChangelog } from "../changelog/index.js";
import { buildMergePlan, type MergePlan } from "../sync/contacts-merge.js";
import { latestRunFor, withTriageRun } from "../sync/triage-runs.js";

const DOMAIN = "contact";

function sevenDaysAgo(now: Date = new Date()): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

/**
 * Authoritative answer to "which rows currently collide with this Google
 * contact's email/phone in the current sheet." Stored row indices on
 * needs_review entries go stale the moment any row is inserted or deleted
 * — never trust them at apply time. Always re-resolve here.
 */
function resolveLiveMatches(
  records: Record<string, string>[],
  subject: { primary_email?: string | null; primary_phone?: string | null },
  via: string,
): number[] {
  const matches: number[] = [];
  if (via === "email" && subject.primary_email) {
    const target = subject.primary_email.toLowerCase().trim();
    if (!target.includes("@")) return [];
    records.forEach((r, i) => {
      if (emailsInRow(r).includes(target)) matches.push(i);
    });
  } else if (via === "phone" && subject.primary_phone) {
    const digits = subject.primary_phone.replace(/\D/g, "");
    const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (normalized.length < 7) return [];
    records.forEach((r, i) => {
      if (phonesInRow(r).includes(normalized)) matches.push(i);
    });
  }
  return matches;
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
        .where(
          and(
            or(
              eq(changelog.targetKind, "contact"),
              eq(changelog.targetKind, "contact_row"),
              eq(changelog.targetKind, "contact_rows"),
              eq(changelog.targetKind, "contact_sheet"),
              like(changelog.operation, "contacts.%"),
            ),
            gte(changelog.createdAt, since),
          ),
        )
        .orderBy(desc(changelog.id))
        .limit(500),
    ]);
    const sessionGroups = groupBySession(activityRows).slice(0, 30);
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
    // Group list lives in Postgres (contact_groups), not the sheet — sheet
    // tab names are too easy to rename. Always loaded so the dropdown works
    // even when sheet creds aren't configured.
    const availableGroups: string[] = (await listGroups()).map((g) => g.name);
    const matchedRowsByEntryId: Record<number, RowPreview[]> = {};
    const mergePreviewByEntryId: Record<number, MergePreview | null> = {};
    if (hasGoogleCreds()) {
      try {
        const creds = requireGoogleCreds();
        sheetUrl = `https://docs.google.com/spreadsheets/d/${creds.sheetId}/edit`;
        const tabName = getConfig().CONTACTS_TAB;
        const tab = await readContactsTab(getOAuthClient(), creds.sheetId, { tab: tabName });
        const records = tab.rows.map((r) => r.record);
        const report = findAuditIssues(records);
        const rowView = (rowIndex: number): RowPreview => {
          const r = records[rowIndex] ?? {};
          const full = (r.full_name ?? "").trim();
          return {
            rowIndex,
            name: full || "(no name)",
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

        // For ambiguous pending reviews, RE-RESOLVE the matching sheet rows
        // at render time by scanning for rows that currently share the
        // contact's email/phone. The cached row indices on the needs_review
        // row are not trustworthy — any row insert or delete shifts the
        // sheet under them.
        for (const entry of pendingRows) {
          if (entry.subjectKind !== "google_contact_ambiguous") continue;
          const subj = (entry.subject ?? {}) as {
            primary_email?: string | null;
            primary_phone?: string | null;
          };
          const action = entry.proposedAction as { matches?: number[]; via?: string } | null;
          const via = action?.via || "email";
          const liveMatches = resolveLiveMatches(records, subj, via);
          if (liveMatches.length > 0) {
            matchedRowsByEntryId[entry.id] = liveMatches.map(rowView);
          }
          if (liveMatches.length >= 2) {
            const matchedFull = liveMatches.map((i) => ({ rowIndex: i, record: records[i] }));
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
          } else {
            // 0 or 1 live matches → the duplicate already resolved itself
            // (or the cached index pointed at unrelated rows). The UI hides
            // the Preview merge button when mergePreviewByEntryId[id] is null.
            mergePreviewByEntryId[entry.id] = null;
          }
        }
      } catch {
        audit = null;
      }
    }
    const run = await latestRunFor("contact");
    res.render("contacts", {
      rules: rulesRows,
      pending: pendingRows,
      activity: activityRows,
      sessionGroups,
      flash: null,
      cron: cronInfoForDomain("contact"),
      audit,
      sheetUrl,
      availableGroups,
      matchedRowsByEntryId,
      mergePreviewByEntryId,
      run,
    });
  });

  router.get("/triage-status", async (req, res) => {
    const polling = req.query.polling === "1";
    const run = await latestRunFor("contact");
    if (polling && run && run.status !== "running") {
      const completedMs = run.completedAt ? new Date(run.completedAt).getTime() : 0;
      if (completedMs && Date.now() - completedMs <= 60_000) {
        res.setHeader("HX-Refresh", "true");
        res.send("");
        return;
      }
    }
    res.render("partials/_triage-status", { run, statusUrl: "/ui/contacts/triage-status" });
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
      const tab = await readContactsTab(client, creds.sheetId, { tab: getConfig().CONTACTS_TAB });
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

  router.post("/sync", async (req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(`<div class="flash err">Google credentials not configured.</div>`);
      return;
    }
    try {
      const creds = requireGoogleCreds();
      const tabName = getConfig().CONTACTS_TAB;
      const result = await withTriageRun(
        "contact",
        req.sessionId,
        "ui:contacts.sync",
        () => runSync(getOAuthClient(), creds.sheetId, { dryRun: false, tab: tabName }),
      );
      res.setHeader("HX-Refresh", "true");
      const s = result.summary;
      const q = result.queued;
      if (q) {
        const remembered = q.blocked_by_prior_reject;
        const rememberedNote = remembered > 0
          ? ` Skipped ${remembered} change${remembered === 1 ? '' : 's'} you previously rejected.`
          : '';
        res.send(
          `<div class="flash ok">Auto-inserted ${q.auto_inserts} new contact${q.auto_inserts === 1 ? '' : 's'} (no groups → pending review). Auto-applied ${q.formatting_refreshes} formatting refresh${q.formatting_refreshes === 1 ? '' : 'es'} + ${q.resource_name_backfills} resource_name backfill${q.resource_name_backfills === 1 ? '' : 's'}. Queued for review: ${q.queued_refreshes} refresh${q.queued_refreshes === 1 ? '' : 'es'}, ${q.queued_ambiguous} ambiguous (${q.skipped_duplicates} already pending).${rememberedNote} ${s.unchanged} unchanged.</div>`,
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
    const action = entry.proposedAction as { matches?: number[]; tab?: string; via?: string } | null;
    const via = action?.via || "email";
    try {
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tab = await readContactsTab(client, creds.sheetId, { tab: getConfig().CONTACTS_TAB });
      const records = tab.rows.map((r) => r.record);
      // Re-resolve LIVE matches by the contact's email/phone in the CURRENT
      // sheet. Trusting the cached proposedAction.matches[] is dangerous —
      // those indices were captured at queue time and the sheet has shifted
      // since (row deletes, manual edits). Without this guard the merge
      // would write to unrelated contacts.
      const subj = (entry.subject ?? {}) as {
        primary_email?: string | null;
        primary_phone?: string | null;
      };
      const liveMatches = resolveLiveMatches(records, subj, via);
      if (liveMatches.length < 2) {
        const what = via === "phone" ? "phone" : "email";
        res
          .status(409)
          .send(
            `<tr style="background:#fcf0f0;"><td colspan="5" style="color: var(--danger);">stale review: only ${liveMatches.length} row(s) currently share this contact's ${what}. The duplicate may already be resolved. Skip this review and re-run sync.</td></tr>`,
          );
        return;
      }
      const matchedRows = liveMatches.map((rowIndex) => ({ rowIndex, record: records[rowIndex] }));
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
        includeBulkCheckbox: true,
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

  // Assign a group to a row in dex_contacts. Used by the "Pending review
  // (no group)" panel — picks the row by row_index + full_name guard, writes
  // the chosen group to the `groups` column, logs to the changelog.
  const AssignGroupBody = z.object({
    row_index: z.coerce.number().int().min(0).max(100_000),
    expected_full_name: z.string().max(500),
    group: z.string().trim().min(1).max(200),
  });

  router.post("/assign-group/:rowIndex", async (req, res) => {
    if (!hasGoogleCreds()) {
      res.status(503).send(
        `<tr><td colspan="6" class="muted">Google credentials not configured.</td></tr>`,
      );
      return;
    }
    let body: z.infer<typeof AssignGroupBody>;
    try {
      body = AssignGroupBody.parse({ ...req.body, row_index: req.params.rowIndex });
    } catch {
      res.status(400).send("invalid request");
      return;
    }
    try {
      await enforceConfiguredDailyLimit("contacts.assign_group");
      const creds = requireGoogleCreds();
      const client = getOAuthClient();
      const tabName = getConfig().CONTACTS_TAB;
      const tab = await readContactsTab(client, creds.sheetId, { tab: tabName });
      if (body.row_index >= tab.rows.length) {
        res
          .status(404)
          .send(
            `<tr style="background:#fcf0f0;"><td colspan="6" style="color: var(--danger);">Row ${body.row_index} no longer exists. Reload.</td></tr>`,
          );
        return;
      }
      const record = tab.rows[body.row_index].record;
      const currentName = (record.full_name ?? "").trim();
      if (currentName !== body.expected_full_name.trim()) {
        res
          .status(409)
          .send(
            `<tr style="background:#fcf0f0;"><td colspan="6" style="color: var(--danger);">Row changed since page load. Reload.</td></tr>`,
          );
        return;
      }
      const colIdx = tab.headers.indexOf("groups");
      if (colIdx === -1) {
        res
          .status(500)
          .send(
            `<tr style="background:#fcf0f0;"><td colspan="6" style="color: var(--danger);">groups column not found in ${tabName}.</td></tr>`,
          );
        return;
      }
      const sheetRow = body.row_index + 2; // +1 1-based, +1 header
      const range = `${tabName}!${colLetter(colIdx)}${sheetRow}`;
      const before = (record.groups ?? "").trim();
      // Append to existing CSV if there's already a value (defensive — the
      // noGroup audit only surfaces rows where groups is empty, but a race
      // could land us here with an existing value).
      const after = before ? `${before}, ${body.group}` : body.group;
      await withChangelog(
        {
          caller: "ui:contacts.assign-group",
          sessionId: req.sessionId,
          operation: "contacts.assign_group",
          targetKind: "contact_row",
          targetId: `${tabName}!row${body.row_index}`,
          intent: `assign group "${body.group}" to ${currentName}`,
          before: { row_index: body.row_index, full_name: currentName, groups: before },
          after: { row_index: body.row_index, full_name: currentName, groups: after },
          externalTarget: `google.sheet:${creds.sheetId}!${range}`,
        },
        async () => {
          await batchUpdateCells(client, creds.sheetId, [{ range, value: after }]);
        },
      );
      // Empty body → HTMX outerHTML swap removes the row from the table.
      res.status(200).send("");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err))
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      res
        .status(500)
        .send(
          `<tr style="background:#fcf0f0;"><td colspan="6" style="color: var(--danger);">assign failed: ${msg}</td></tr>`,
        );
    }
  });

  return router;
}
