import { Router } from "express";
import { runBackup } from "../backup/pg_dump.js";
import { runGithubBackup } from "../backup/github_snapshot.js";
import type { BackupCronOptions } from "../crons/backup.js";
import type { GithubBackupCronOptions } from "../crons/github-backup.js";

export type AdminRouterOptions = {
  /** Pre-built backup options (same ones the cron uses). Omitted if R2 isn't configured. */
  backup?: BackupCronOptions;
  /** Pre-built github-snapshot options (same ones that cron uses). */
  githubBackup?: GithubBackupCronOptions;
};

export function makeAdminRouter(opts: AdminRouterOptions): Router {
  const router = Router();

  // POST /admin/backup-now — fires the same dump+upload the cron uses, so
  // verifying a config change doesn't require waiting until 3:15 UTC. Calls
  // runBackup (not runBackupOnce) so errors bubble back as JSON instead of
  // being swallowed to a log line.
  router.post("/backup-now", async (_req, res) => {
    if (!opts.backup) {
      res.status(503).json({
        ok: false,
        error:
          "r2 backup not configured (missing R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)",
      });
      return;
    }
    const started = Date.now();
    try {
      const result = await runBackup({
        databaseUrl: opts.backup.databaseUrl,
        r2: opts.backup.r2,
      });
      res.json({
        ok: true,
        key: result.key,
        bytes: result.bytes,
        duration_ms: result.durationMs,
        bucket: opts.backup.r2.bucket,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        ok: false,
        error: message,
        duration_ms: Date.now() - started,
      });
    }
  });

  // POST /admin/github-backup-now — same shape as /backup-now, but pulls a
  // tarball of the repo at the configured ref from GitHub and uploads it to R2.
  router.post("/github-backup-now", async (_req, res) => {
    if (!opts.githubBackup) {
      res.status(503).json({
        ok: false,
        error:
          "github backup not configured (missing GITHUB_TOKEN, GITHUB_BACKUP_REPO, or R2 vars)",
      });
      return;
    }
    const started = Date.now();
    try {
      const result = await runGithubBackup({
        github: opts.githubBackup.github,
        r2: opts.githubBackup.r2,
      });
      res.json({
        ok: true,
        key: result.key,
        bytes: result.bytes,
        duration_ms: result.durationMs,
        bucket: opts.githubBackup.r2.bucket,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        ok: false,
        error: message,
        duration_ms: Date.now() - started,
      });
    }
  });

  return router;
}
