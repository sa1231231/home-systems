import cron from "node-cron";
import { randomUUID } from "crypto";
import { MissingGoogleCredsError, requireGoogleCreds } from "../integrations/google/oauth.js";
import { triageAllAccounts } from "../sync/email-triage.js";

export type EmailTriageCronOptions = {
  enabled: boolean;
  schedule: string;
  timezone?: string;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startEmailTriageCron(opts: EmailTriageCronOptions): void {
  if (!opts.enabled) {
    console.log("[cron] email triage disabled (set EMAIL_TRIAGE_CRON_ENABLED=true to enable)");
    return;
  }
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid EMAIL_TRIAGE_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  const tz = opts.timezone || "UTC";
  console.log(`[cron] email triage scheduled: "${opts.schedule}" (${tz})`);
  scheduledTask = cron.schedule(opts.schedule, () => runEmailTriageOnce(), {
    timezone: tz,
  });
}

export function stopEmailTriageCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

export async function runEmailTriageOnce(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sessionId = `cron:${randomUUID()}`;
  console.log(`[cron] email triage starting at ${startedAt} sessionId=${sessionId}`);
  try {
    requireGoogleCreds();
    const summary = await triageAllAccounts({
      sessionId,
      caller: "cron:email-triage",
    });
    console.log(
      `[cron] email triage done across ${summary.accounts.length} account(s): ` +
        `matched=${summary.matched} queued=${summary.queued} skipped=${summary.skipped} ` +
        `errors=${summary.errors} total=${summary.total}`,
    );
  } catch (err) {
    if (err instanceof MissingGoogleCredsError) {
      console.error("[cron] email triage skipped: google credentials not configured");
      return;
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cron] email triage FAILED: ${message}`);
  }
}
