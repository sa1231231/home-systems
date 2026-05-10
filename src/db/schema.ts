import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
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
