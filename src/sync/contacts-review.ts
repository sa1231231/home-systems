import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { needsReview } from "../db/schema.js";
import type { GooglePerson } from "../integrations/google/people.js";
import type { AmbiguousOp, FieldChange, InsertOp, RefreshOp, SyncPlan } from "./contacts.js";

export const CONTACT_DOMAIN = "contact";
export const CONTACT_INSERT_KIND = "google_contact_insert";
export const CONTACT_REFRESH_KIND = "google_contact_refresh";
export const CONTACT_AMBIGUOUS_KIND = "google_contact_ambiguous";

/** Compact preview of a Google person for the needs_review subject column. */
function personPreview(p: GooglePerson): Record<string, unknown> {
  return {
    resource_name: p.resource_name,
    display_name: p.display_name,
    primary_email: p.emails[0] ?? null,
    primary_phone: p.phones[0] ?? null,
    company: p.company ?? null,
    job_title: p.job_title ?? null,
  };
}

export type InsertReviewAction = {
  type: "insert";
  tab: string;
  headers: string[];
  values: string[];
};

export type RefreshReviewAction = {
  type: "refresh";
  tab: string;
  row_index: number;
  via: "resource_name" | "email" | "phone" | "name";
  updates: FieldChange[];
};

export type AmbiguousReviewAction = {
  type: "ambiguous";
  tab: string;
  matches: number[];
  via: "email" | "phone" | "name";
};

export type ContactReviewAction = InsertReviewAction | RefreshReviewAction | AmbiguousReviewAction;

export type EnqueueSummary = {
  queued_inserts: number;
  queued_refreshes: number;
  queued_ambiguous: number;
  skipped_duplicates: number;
};

export function buildInsertReview(op: InsertOp, plan: SyncPlan): {
  subject: Record<string, unknown>;
  subjectId: string;
  action: InsertReviewAction;
} {
  return {
    subject: {
      kind: "insert",
      tab: plan.tab,
      ...personPreview(op.person),
    },
    subjectId: op.person.resource_name,
    action: { type: "insert", tab: plan.tab, headers: plan.headers, values: op.values },
  };
}

export function buildRefreshReview(op: RefreshOp, plan: SyncPlan): {
  subject: Record<string, unknown>;
  subjectId: string;
  action: RefreshReviewAction;
} {
  return {
    subject: {
      kind: "refresh",
      tab: plan.tab,
      row_index: op.rowIndex,
      via: op.via,
      changed_fields: op.updates.map((u) => u.col),
      ...personPreview(op.person),
    },
    subjectId: op.person.resource_name,
    action: {
      type: "refresh",
      tab: plan.tab,
      row_index: op.rowIndex,
      via: op.via,
      updates: op.updates,
    },
  };
}

export function buildAmbiguousReview(op: AmbiguousOp, plan: SyncPlan): {
  subject: Record<string, unknown>;
  subjectId: string;
  action: AmbiguousReviewAction;
} {
  return {
    subject: {
      kind: "ambiguous",
      tab: plan.tab,
      matches: op.matches,
      via: op.via,
      ...personPreview(op.person),
    },
    subjectId: op.person.resource_name,
    action: { type: "ambiguous", tab: plan.tab, matches: op.matches, via: op.via },
  };
}

/**
 * Find an existing pending needs_review row for this kind+subject. Used so a
 * second cron run doesn't pile duplicate queue entries for the same contact.
 */
async function findExistingPending(
  database: typeof defaultDb,
  subjectKind: string,
  subjectId: string,
): Promise<number | null> {
  const [row] = await database
    .select({ id: needsReview.id })
    .from(needsReview)
    .where(
      and(
        eq(needsReview.domain, CONTACT_DOMAIN),
        eq(needsReview.subjectKind, subjectKind),
        eq(needsReview.subjectId, subjectId),
        eq(needsReview.status, "pending"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function upsertReview(
  database: typeof defaultDb,
  subjectKind: string,
  subjectId: string,
  subject: Record<string, unknown>,
  proposed: ContactReviewAction,
): Promise<"inserted" | "updated"> {
  const existing = await findExistingPending(database, subjectKind, subjectId);
  if (existing) {
    await database
      .update(needsReview)
      .set({
        subject: subject as never,
        proposedAction: proposed as never,
        updatedAt: new Date(),
      })
      .where(eq(needsReview.id, existing));
    return "updated";
  }
  await database.insert(needsReview).values({
    domain: CONTACT_DOMAIN,
    subject: subject as never,
    subjectKind,
    subjectId,
    proposedAction: proposed as never,
    status: "pending",
  });
  return "inserted";
}

export async function enqueueSyncPlan(
  plan: SyncPlan,
  options: { database?: typeof defaultDb } = {},
): Promise<EnqueueSummary> {
  const database = options.database ?? defaultDb;
  let qi = 0,
    qr = 0,
    qa = 0,
    skipped = 0;

  for (const op of plan.inserts) {
    if (!op.person.resource_name) continue;
    const { subject, subjectId, action } = buildInsertReview(op, plan);
    const r = await upsertReview(database, CONTACT_INSERT_KIND, subjectId, subject, action);
    if (r === "inserted") qi++;
    else skipped++;
  }
  for (const op of plan.refreshes) {
    if (!op.person.resource_name) continue;
    const { subject, subjectId, action } = buildRefreshReview(op, plan);
    const r = await upsertReview(database, CONTACT_REFRESH_KIND, subjectId, subject, action);
    if (r === "inserted") qr++;
    else skipped++;
  }
  for (const op of plan.ambiguous) {
    if (!op.person.resource_name) continue;
    const { subject, subjectId, action } = buildAmbiguousReview(op, plan);
    const r = await upsertReview(database, CONTACT_AMBIGUOUS_KIND, subjectId, subject, action);
    if (r === "inserted") qa++;
    else skipped++;
  }

  return {
    queued_inserts: qi,
    queued_refreshes: qr,
    queued_ambiguous: qa,
    skipped_duplicates: skipped,
  };
}
