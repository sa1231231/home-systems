import "dotenv/config";
import { z } from "zod";

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
  CRM_SHEET_ID: z.string().optional(),
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
  EMAIL_TRIAGE_CRON_LIMIT: z.coerce.number().int().positive().max(500).default(50),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  BACKUP_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  BACKUP_CRON_SCHEDULE: z.string().default("15 3 * * *"),
  UI_AUTH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  UI_PASSWORD: z.string().min(8).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
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
