import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const meta = pgTable("_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const changelog = pgTable(
  "changelog",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    caller: text("caller").notNull(),
    sessionId: text("session_id").notNull(),
    operation: text("operation").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    intent: text("intent"),
    beforeState: jsonb("before_state").notNull().default(sql`'{}'::jsonb`),
    afterState: jsonb("after_state").notNull().default(sql`'{}'::jsonb`),
    externalTarget: text("external_target"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    undoneBy: bigint("undone_by", { mode: "number" }),
  },
  (t) => ({
    sessionIdx: index("changelog_session_idx").on(t.sessionId),
    operationIdx: index("changelog_operation_created_idx").on(t.operation, t.createdAt),
    targetIdx: index("changelog_target_idx").on(t.targetKind, t.targetId, t.createdAt),
  }),
);

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    classifier: text("classifier").notNull(),
    caller: text("caller").notNull(),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    input: text("input").notNull(),
    rawOutput: text("raw_output").notNull(),
    parsedOutput: jsonb("parsed_output"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    effort: text("effort").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    status: text("status").notNull(),
    error: text("error"),
    intent: text("intent"),
  },
  (t) => ({
    classifierIdx: index("ai_calls_classifier_created_idx").on(t.classifier, t.createdAt),
    statusIdx: index("ai_calls_status_created_idx").on(t.status, t.createdAt),
  }),
);

export const rules = pgTable(
  "rules",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    match: jsonb("match").notNull(),
    action: jsonb("action").notNull(),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    createdFromReviewId: bigint("created_from_review_id", { mode: "number" }),
    createdBy: text("created_by").notNull(),
    notes: text("notes"),
  },
  (t) => ({
    domainEnabledPriorityIdx: index("rules_domain_enabled_priority_idx").on(
      t.domain,
      t.enabled,
      t.priority,
    ),
    fromReviewIdx: index("rules_from_review_idx").on(t.createdFromReviewId),
    // At most one enabled rule per (domain, match) — prevents duplicate
    // identical rules. Disabled rules are excluded so soft-deletes don't block.
    domainMatchUnique: uniqueIndex("rules_domain_match_unique")
      .on(t.domain, t.match)
      .where(sql`${t.enabled}`),
  }),
);

export const needsReview = pgTable(
  "needs_review",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    domain: text("domain").notNull(),
    subject: jsonb("subject").notNull().default(sql`'{}'::jsonb`),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    aiCallId: bigint("ai_call_id", { mode: "number" }),
    proposedAction: jsonb("proposed_action").notNull(),
    status: text("status").notNull().default("pending"),
    decision: jsonb("decision"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    promotedToRuleId: bigint("promoted_to_rule_id", { mode: "number" }),
    notes: text("notes"),
  },
  (t) => ({
    domainStatusIdx: index("needs_review_domain_status_created_idx").on(
      t.domain,
      t.status,
      t.createdAt,
    ),
    subjectIdx: index("needs_review_subject_idx").on(t.subjectKind, t.subjectId),
    aiCallIdx: index("needs_review_ai_call_idx").on(t.aiCallId),
  }),
);

export const processedEmails = pgTable(
  "processed_emails",
  {
    id: text("id").notNull(),
    // Which Gmail account this message belongs to. Message IDs are not
    // guaranteed unique across accounts, so the dedup key is (account, id).
    // Legacy rows (pre-multi-account) carry the empty string.
    account: text("account").notNull().default(""),
    threadId: text("thread_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").notNull(),
    outcomeId: bigint("outcome_id", { mode: "number" }),
    error: text("error"),
    // EmailSubject snapshot captured at triage time so the UI can render the
    // Recent activity strip + Wrong-call form without re-fetching from Gmail.
    emailMeta: jsonb("email_meta"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.account, t.id] }),
    outcomeIdx: index("processed_emails_outcome_idx").on(t.outcome, t.lastProcessedAt),
    threadIdx: index("processed_emails_thread_idx").on(t.threadId),
  }),
);

export const processedTransactions = pgTable(
  "processed_transactions",
  {
    id: text("id").primaryKey(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").notNull(),
    outcomeId: bigint("outcome_id", { mode: "number" }),
    error: text("error"),
  },
  (t) => ({
    outcomeIdx: index("processed_transactions_outcome_idx").on(t.outcome, t.lastProcessedAt),
  }),
);

/**
 * Per-contact baseline: the Google identity fields as of the last sync.
 * Lets contacts sync do a 3-way compare (Google-now / Sheet-now / snapshot)
 * so it can tell "Google changed" from "the user hand-edited the sheet" and
 * never silently overwrites a sheet edit. Keyed by Google's stable
 * resource_name. `fields` holds the IDENTITY_COLUMNS shape.
 */
export const contactSnapshots = pgTable("contact_snapshots", {
  resourceName: text("resource_name").primaryKey(),
  fields: jsonb("fields").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dailyOpCounters = pgTable(
  "daily_op_counters",
  {
    operation: text("operation").notNull(),
    day: text("day").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.operation, t.day] }),
  }),
);

/**
 * One row per manual or cron-triggered triage/sync run, used to surface
 * "Triage is currently running" banners that survive page reload. Status
 * transitions running → success | error. Summary is the domain-specific
 * payload (TriageSummary, SyncSummary, ReorderResult counts, etc.).
 */
/**
 * Web scraper output. One row per item scraped from a source, deduped by
 * (kind, item_url). `kind` discriminates the source family (e.g.
 * "ai_news", "events"). Content is intentionally stored truncated — the
 * goal is enough text to summarize, not full archives.
 */
export const scraperItems = pgTable(
  "scraper_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    itemUrl: text("item_url").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    rawSnippet: text("raw_snippet"),
  },
  (t) => ({
    kindCreatedIdx: index("scraper_items_kind_created_idx").on(t.kind, t.createdAt),
    uniqueKindUrl: index("scraper_items_kind_url_idx").on(t.kind, t.itemUrl),
  }),
);

/**
 * AI-generated briefing/digest produced from a batch of scraper_items.
 * One row per (kind, run). Each digest references the item IDs it
 * summarized and stores the AI's narrative output.
 */
export const scraperDigests = pgTable(
  "scraper_digests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    itemIds: jsonb("item_ids").notNull().default(sql`'[]'::jsonb`),
    summary: text("summary").notNull(),
    aiCallId: bigint("ai_call_id", { mode: "number" }),
  },
  (t) => ({
    kindCreatedIdx: index("scraper_digests_kind_created_idx").on(t.kind, t.createdAt),
  }),
);

/**
 * The set of group names contacts can be filed under (e.g. "Real Estate",
 * "Coaches", "LinkedIn Connections"). Seeded once from the distinct values
 * already present in dex_contacts.groups; new groups can be added directly
 * here without touching the sheet. Acts as the authoritative source for the
 * UI dropdown — no more reading from a renameable Sheets tab.
 */
export const contactGroups = pgTable(
  "contact_groups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull().unique(),
    /** Optional sort weight (lower first). Defaults to 100 so manual
     *  reordering is possible without touching every row. */
    sortOrder: integer("sort_order").notNull().default(100),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("contact_groups_name_idx").on(t.name),
  }),
);

export const triageRuns = pgTable(
  "triage_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    domain: text("domain").notNull(), // "email" | "transaction" | "contact" | "trello"
    caller: text("caller").notNull(),
    sessionId: text("session_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().default("running"), // running | success | error
    summary: jsonb("summary"),
    error: text("error"),
  },
  (t) => ({
    domainStartedIdx: index("triage_runs_domain_started_idx").on(t.domain, t.startedAt),
    statusIdx: index("triage_runs_status_idx").on(t.status, t.startedAt),
  }),
);
