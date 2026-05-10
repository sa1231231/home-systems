import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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
