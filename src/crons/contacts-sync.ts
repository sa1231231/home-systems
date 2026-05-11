import cron from "node-cron";
import { getOAuthClient, MissingGoogleCredsError, requireGoogleCreds } from "../integrations/google/oauth.js";
import { runSync } from "../sync/contacts.js";

export type ContactsSyncCronOptions = {
  enabled: boolean;
  schedule: string;
  timezone?: string;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startContactsSyncCron(opts: ContactsSyncCronOptions): void {
  if (!opts.enabled) {
    console.log("[cron] contacts sync disabled (set CONTACTS_SYNC_CRON_ENABLED=true to enable)");
    return;
  }
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid CONTACTS_SYNC_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  const tz = opts.timezone || "UTC";
  console.log(`[cron] contacts sync scheduled: "${opts.schedule}" (${tz})`);
  scheduledTask = cron.schedule(opts.schedule, runContactsSyncOnce, { timezone: tz });
}

export function stopContactsSyncCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

export async function runContactsSyncOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[cron] contacts sync starting at ${startedAt}`);
  try {
    const creds = requireGoogleCreds();
    const client = getOAuthClient();
    const { summary } = await runSync(client, creds.sheetId, { dryRun: false });
    console.log(
      `[cron] contacts sync done: inserted=${summary.inserted} refreshed=${summary.refreshed} unchanged=${summary.unchanged} ambiguous=${summary.ambiguous}`,
    );
  } catch (err) {
    if (err instanceof MissingGoogleCredsError) {
      console.error("[cron] contacts sync skipped: google credentials not configured");
      return;
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cron] contacts sync FAILED: ${message}`);
  }
}
