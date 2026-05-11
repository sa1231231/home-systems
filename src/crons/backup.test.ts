import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-cron", () => ({
  default: { validate: vi.fn(), schedule: vi.fn() },
}));
vi.mock("../backup/pg_dump.js", async () => {
  const actual = await vi.importActual<typeof import("../backup/pg_dump.js")>(
    "../backup/pg_dump.js",
  );
  return { ...actual, runBackup: vi.fn() };
});

import cron from "node-cron";
import { runBackup } from "../backup/pg_dump.js";
import { runBackupOnce, startBackupCron, stopBackupCron } from "./backup.js";

const validateMock = vi.mocked(cron.validate);
const scheduleMock = vi.mocked(cron.schedule);
const runBackupMock = vi.mocked(runBackup);

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const OPTS = {
  enabled: true,
  schedule: "15 3 * * *",
  databaseUrl: "postgres://test",
  r2: {
    accountId: "acct",
    accessKeyId: "k",
    secretAccessKey: "s",
    bucket: "b",
  },
};

beforeEach(() => {
  validateMock.mockReset();
  scheduleMock.mockReset();
  runBackupMock.mockReset();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  stopBackupCron();
});
afterEach(() => {
  stopBackupCron();
});

describe("startBackupCron", () => {
  it("disabled → no schedule", () => {
    startBackupCron({ ...OPTS, enabled: false });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("invalid schedule → error log", () => {
    validateMock.mockReturnValue(false);
    startBackupCron({ ...OPTS, schedule: "bad" });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("valid config schedules with timezone=UTC", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startBackupCron(OPTS);
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "UTC" });
  });
});

describe("runBackupOnce", () => {
  it("calls runBackup with the configured database + r2", async () => {
    runBackupMock.mockResolvedValueOnce({ key: "k", bytes: 100, durationMs: 5 } as never);
    await runBackupOnce(OPTS);
    expect(runBackupMock).toHaveBeenCalledWith({
      databaseUrl: OPTS.databaseUrl,
      r2: OPTS.r2,
    });
  });

  it("swallows errors with a FAILED log", async () => {
    runBackupMock.mockRejectedValueOnce(new Error("pg_dump fail"));
    await runBackupOnce(OPTS);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED/));
  });
});
