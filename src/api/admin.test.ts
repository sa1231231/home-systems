import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { makeTestApp } from "../../tests/helpers/test-app.js";

vi.mock("../backup/pg_dump.js", () => ({
  runBackup: vi.fn(),
}));
vi.mock("../backup/github_snapshot.js", () => ({
  runGithubBackup: vi.fn(),
}));

import { runBackup } from "../backup/pg_dump.js";
import { runGithubBackup } from "../backup/github_snapshot.js";
import { makeAdminRouter } from "./admin.js";

const runBackupMock = vi.mocked(runBackup);
const runGithubBackupMock = vi.mocked(runGithubBackup);

const BACKUP_OPTS = {
  schedule: "manual",
  databaseUrl: "postgres://x",
  r2: {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucket: "home-systems-backups",
  },
};

function appWith(opts: Parameters<typeof makeAdminRouter>[0]) {
  const app = makeTestApp();
  app.use("/admin", makeAdminRouter(opts));
  return app;
}

const GH_OPTS = {
  schedule: "20 3 * * *",
  github: { repo: "sa1231231/home-systems", ref: "main", token: "ghp_x" },
  r2: BACKUP_OPTS.r2,
};

beforeEach(() => {
  runBackupMock.mockReset();
  runGithubBackupMock.mockReset();
});

describe("POST /admin/backup-now", () => {
  it("503s with a clear hint when R2 isn't configured", async () => {
    const res = await request(appWith({})).post("/admin/backup-now");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/r2 backup not configured/i);
    expect(runBackupMock).not.toHaveBeenCalled();
  });

  it("calls runBackup with the configured database + r2 and returns the result", async () => {
    runBackupMock.mockResolvedValueOnce({
      key: "home-systems/2026-05-20T1530Z.sql.gz",
      bytes: 1234,
      durationMs: 42,
    });
    const res = await request(appWith({ backup: BACKUP_OPTS })).post("/admin/backup-now");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      key: "home-systems/2026-05-20T1530Z.sql.gz",
      bytes: 1234,
      duration_ms: 42,
      bucket: "home-systems-backups",
    });
    expect(runBackupMock).toHaveBeenCalledWith({
      databaseUrl: BACKUP_OPTS.databaseUrl,
      r2: BACKUP_OPTS.r2,
    });
  });

  it("500s with the error message when runBackup throws (no swallowing)", async () => {
    runBackupMock.mockRejectedValueOnce(new Error("pg_dump exited with code 1: bad creds"));
    const res = await request(appWith({ backup: BACKUP_OPTS })).post("/admin/backup-now");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("pg_dump exited with code 1");
    expect(typeof res.body.duration_ms).toBe("number");
  });
});

describe("POST /admin/github-backup-now", () => {
  it("503s when github backup isn't configured", async () => {
    const res = await request(appWith({})).post("/admin/github-backup-now");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/github backup not configured/i);
    expect(runGithubBackupMock).not.toHaveBeenCalled();
  });

  it("calls runGithubBackup with the configured repo + r2 and returns the result", async () => {
    runGithubBackupMock.mockResolvedValueOnce({
      key: "home-systems-source/2026-05-20T1720Z.tar.gz",
      bytes: 250_000,
      durationMs: 110,
    });
    const res = await request(appWith({ githubBackup: GH_OPTS })).post(
      "/admin/github-backup-now",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      key: "home-systems-source/2026-05-20T1720Z.tar.gz",
      bytes: 250_000,
      duration_ms: 110,
      bucket: "home-systems-backups",
    });
    expect(runGithubBackupMock).toHaveBeenCalledWith({
      github: GH_OPTS.github,
      r2: GH_OPTS.r2,
    });
  });

  it("500s with the upstream error when runGithubBackup throws", async () => {
    runGithubBackupMock.mockRejectedValueOnce(new Error("github tarball fetch failed: 401"));
    const res = await request(appWith({ githubBackup: GH_OPTS })).post(
      "/admin/github-backup-now",
    );
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/401/);
  });
});
