import cron from "node-cron";
import { runGithubBackup, type GithubSnapshotConfig } from "../backup/github_snapshot.js";
import type { R2Config } from "../backup/pg_dump.js";

export type GithubBackupCronOptions = {
  schedule: string;
  github: GithubSnapshotConfig;
  r2: R2Config;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startGithubBackupCron(opts: GithubBackupCronOptions): void {
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid GITHUB_BACKUP_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  console.log(
    `[cron] github backup scheduled: "${opts.schedule}" (UTC) repo=${opts.github.repo} ref=${opts.github.ref ?? "main"}`,
  );
  scheduledTask = cron.schedule(opts.schedule, () => runGithubBackupOnce(opts), {
    timezone: "UTC",
  });
}

export function stopGithubBackupCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

export async function runGithubBackupOnce(opts: GithubBackupCronOptions): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[cron] github backup starting at ${startedAt}`);
  try {
    const result = await runGithubBackup({ github: opts.github, r2: opts.r2 });
    console.log(
      `[cron] github backup done: key=${result.key} bytes=${result.bytes} duration_ms=${result.durationMs}`,
    );
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[cron] github backup FAILED: ${message}`);
  }
}
