import "dotenv/config";
import { z } from "zod";

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
  // JSON array of OAuth refresh tokens for additional Gmail accounts to triage.
  // The primary GOOGLE_OAUTH_REFRESH_TOKEN is always included on top of these.
  GMAIL_ACCOUNTS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || !v.trim()) return [] as string[];
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GMAIL_ACCOUNTS must be valid JSON" });
        return z.NEVER;
      }
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string" && x.length > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GMAIL_ACCOUNTS must be a JSON array of non-empty strings",
        });
        return z.NEVER;
      }
      return parsed as string[];
    }),
  CRM_SHEET_ID: z.string().optional(),
  CONTACTS_TAB: z.string().default("dex_contacts"),
  CONTACTS_SYNC_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CONTACTS_SYNC_CRON_SCHEDULE: z.string().default("0 7 * * *"),
  ANTHROPIC_API_KEY: z.string().optional(),
  EMAIL_TRIAGE_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  EMAIL_TRIAGE_CRON_SCHEDULE: z.string().default("0 7 * * *"),
  TRANSACTIONS_SHEET_ID: z.string().optional(),
  TRANSACTIONS_TAB: z.string().default("Transactions"),
  CATEGORIES_TAB: z.string().default("Categories"),
  TRANSACTION_TRIAGE_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  TRANSACTION_TRIAGE_CRON_SCHEDULE: z.string().default("0 8 * * *"),
  TRANSACTION_TRIAGE_CRON_LIMIT: z.coerce.number().int().positive().max(500).default(50),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  BACKUP_CRON_SCHEDULE: z.string().default("15 3 * * *"),
  // GitHub source-tree backup (nightly tarball → R2). Disabled unless
  // GITHUB_TOKEN + GITHUB_BACKUP_REPO are both set.
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_BACKUP_REPO: z.string().optional(),
  GITHUB_BACKUP_REF: z.string().default("main"),
  GITHUB_BACKUP_CRON_SCHEDULE: z.string().default("20 3 * * *"),
  UI_AUTH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  UI_PASSWORD: z.string().min(8).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  TRELLO_API_KEY: z.string().min(8).optional(),
  TRELLO_TOKEN: z.string().min(8).optional(),
  TRELLO_BOARD_ID: z.string().min(1).optional(),
  TRELLO_WAITING_LIST_ID: z.string().min(1).optional(),
  TRELLO_TODAY_LIST_ID: z.string().min(1).optional(),
  TRELLO_DAILY_FIELD_ID: z.string().min(1).optional(),
  TRELLO_WEEKDAYS_FIELD_ID: z.string().min(1).optional(),
  TRELLO_WEEKENDS_FIELD_ID: z.string().min(1).optional(),
  CRON_TZ: z.string().default("America/New_York"),
  TRELLO_REORDER_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  TRELLO_REORDER_CRON_SCHEDULE: z.string().default("0 11 * * *"),
  EVENTS_LOCATION: z.string().default("Richmond, VA"),
  EVENTBRITE_API_KEY: z.string().optional(),
  // Outbound notification channel. Currently only Discord webhook is wired up;
  // adding Pushover/Telegram/etc. would add new env vars here and a new branch
  // in src/integrations/notify/client.ts. If unset, sendNotification() no-ops
  // (so a half-configured Railway env doesn't crash the cron).
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  // Daily birthday-reminder cron. Reads the dex_contacts sheet, finds
  // contacts whose birthday is 7 days away or today, sends one Discord
  // message per trigger, and records the send in notification_log to
  // prevent duplicates if the cron fires more than once a day.
  BIRTHDAY_REMINDER_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  BIRTHDAY_REMINDER_CRON_SCHEDULE: z.string().default("0 8 * * *"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
