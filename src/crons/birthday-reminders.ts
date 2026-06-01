import cron from "node-cron";
import { randomUUID } from "crypto";
import {
  MissingGoogleCredsError,
  getOAuthClient,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { runBirthdayReminders } from "../sync/birthday-reminders.js";

export type BirthdayReminderCronOptions = {
  enabled: boolean;
  schedule: string;
  timezone?: string;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startBirthdayReminderCron(opts: BirthdayReminderCronOptions): void {
  if (!opts.enabled) {
    console.log(
      "[cron] birthday reminders disabled (set BIRTHDAY_REMINDER_CRON_ENABLED=true to enable)",
    );
    return;
  }
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid BIRTHDAY_REMINDER_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  const tz = opts.timezone || "UTC";
  console.log(`[cron] birthday reminders scheduled: "${opts.schedule}" (${tz})`);
  scheduledTask = cron.schedule(opts.schedule, () => runBirthdayReminderOnce(), {
    timezone: tz,
  });
}

export function stopBirthdayReminderCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

/** Single-shot entry point — called by node-cron on each tick AND
 *  available for manual invocation (one-off scripts, future UI button). */
export async function runBirthdayReminderOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sessionId = `cron:${randomUUID()}`;
  console.log(`[cron] birthday reminders starting at ${startedAt} sessionId=${sessionId}`);
  try {
    const creds = requireGoogleCreds();
    const oauth = getOAuthClient();
    const summary = await runBirthdayReminders({
      oauth,
      sheetId: creds.sheetId,
      sessionId,
    });
    console.log(
      `[cron] birthday reminders done: matched=${summary.matched} sent=${summary.sent} ` +
        `skipped=${summary.skipped} errors=${summary.errors}`,
    );
  } catch (err) {
    if (err instanceof MissingGoogleCredsError) {
      console.error("[cron] birthday reminders skipped: google credentials not configured");
      return;
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cron] birthday reminders FAILED: ${message}`);
  }
}
