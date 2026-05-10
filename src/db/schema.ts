import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").notNull(),
    outcomeId: bigint("outcome_id", { mode: "number" }),
    error: text("error"),
  },
  (t) => ({
    outcomeIdx: index("processed_emails_outcome_idx").on(t.outcome, t.lastProcessedAt),
    threadIdx: index("processed_emails_thread_idx").on(t.threadId),
  }),
);
