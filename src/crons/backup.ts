import cron from "node-cron";
import { runBackup, type R2Config } from "../backup/pg_dump.js";

export type BackupCronOptions = {
  schedule: string;
  databaseUrl: string;
  r2: R2Config;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startBackupCron(opts: BackupCronOptions): void {
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid BACKUP_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  console.log(`[cron] r2 backup scheduled: "${opts.schedule}" (UTC)`);
  scheduledTask = cron.schedule(opts.schedule, () => runBackupOnce(opts), { timezone: "UTC" });
}

export function stopBackupCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

export async function runBackupOnce(opts: BackupCronOptions): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[cron] r2 backup starting at ${startedAt}`);
  try {
    const result = await runBackup({ databaseUrl: opts.databaseUrl, r2: opts.r2 });
    console.log(
      `[cron] r2 backup done: key=${result.key} bytes=${result.bytes} duration_ms=${result.durationMs}`,
    );
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[cron] r2 backup FAILED: ${message}`);
  }
}
