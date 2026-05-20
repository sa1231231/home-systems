import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { makeTestApp } from "../../tests/helpers/test-app.js";

vi.mock("../backup/pg_dump.js", () => ({
  runBackup: vi.fn(),
}));

import { runBackup } from "../backup/pg_dump.js";
import { makeAdminRouter } from "./admin.js";

const runBackupMock = vi.mocked(runBackup);

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

beforeEach(() => {
  runBackupMock.mockReset();
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
