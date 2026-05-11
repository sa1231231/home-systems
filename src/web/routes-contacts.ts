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
import { findAuditIssues, type AuditReport } from "../sync/contacts-audit.js";
import { readContactsTab, getSheetIdByTitle, deleteDataRows } from "../integrations/google/sheets.js";
import { withChangelog } from "../changelog/index.js";

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
    let audit: (AuditReport & { totalRows: number }) | null = null;
    if (hasGoogleCreds()) {
      try {
        const creds = requireGoogleCreds();
        const tab = await readContactsTab(getOAuthClient(), creds.sheetId);
        const report = findAuditIssues(tab.rows.map((r) => r.record));
        audit = { ...report, totalRows: tab.rows.length };
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
      const { summary } = await runSync(getOAuthClient(), creds.sheetId, { dryRun: false });
      res.setHeader("HX-Refresh", "true");
      res.send(
        `<div class="flash ok">Sync done: inserted=${summary.inserted} refreshed=${summary.refreshed} unchanged=${summary.unchanged} ambiguous=${summary.ambiguous}</div>`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .send(
          `<div class="flash err">Sync failed: ${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
        );
    }
  });

  return router;
}
