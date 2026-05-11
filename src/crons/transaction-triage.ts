import cron from "node-cron";
import { randomUUID } from "crypto";
import {
  getOAuthClient,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { triageTransactions } from "../sync/transaction-triage.js";
import type { TransactionTarget } from "../sync/transaction-actions.js";

export type TransactionTriageCronOptions = {
  enabled: boolean;
  schedule: string;
  limit: number;
  target?: TransactionTarget;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startTransactionTriageCron(opts: TransactionTriageCronOptions): void {
  if (!opts.enabled) {
    console.log(
      "[cron] transaction triage disabled (set TRANSACTION_TRIAGE_CRON_ENABLED=true to enable)",
    );
    return;
  }
  if (!opts.target) {
    console.log(
      "[cron] transaction triage skipped: TRANSACTIONS_SHEET_ID is not configured",
    );
    return;
  }
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid TRANSACTION_TRIAGE_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  const target = opts.target;
  console.log(
    `[cron] transaction triage scheduled: "${opts.schedule}" (UTC), limit=${opts.limit}`,
  );
  scheduledTask = cron.schedule(
    opts.schedule,
    () => runTransactionTriageOnce({ limit: opts.limit, target }),
    { timezone: "UTC" },
  );
}

export function stopTransactionTriageCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

export async function runTransactionTriageOnce(opts: {
  limit: number;
  target: TransactionTarget;
}): Promise<void> {
  const startedAt = new Date().toISOString();
  const sessionId = `cron:${randomUUID()}`;
  console.log(`[cron] transaction triage starting at ${startedAt} sessionId=${sessionId}`);
  try {
    requireGoogleCreds();
    const client = getOAuthClient();
    const summary = await triageTransactions(client, {
      limit: opts.limit,
      sessionId,
      caller: "cron:transaction-triage",
      target: opts.target,
    });
    console.log(
      `[cron] transaction triage done: matched=${summary.matched} queued=${summary.queued} skipped=${summary.skipped} errors=${summary.errors} total=${summary.total}`,
    );
  } catch (err) {
    if (err instanceof MissingGoogleCredsError) {
      console.error("[cron] transaction triage skipped: google credentials not configured");
      return;
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cron] transaction triage FAILED: ${message}`);
  }
}
