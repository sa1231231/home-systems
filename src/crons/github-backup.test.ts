import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-cron", () => ({
  default: { validate: vi.fn(), schedule: vi.fn() },
}));
vi.mock("../backup/github_snapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../backup/github_snapshot.js")>(
    "../backup/github_snapshot.js",
  );
  return { ...actual, runGithubBackup: vi.fn() };
});

import cron from "node-cron";
import { runGithubBackup } from "../backup/github_snapshot.js";
import {
  runGithubBackupOnce,
  startGithubBackupCron,
  stopGithubBackupCron,
} from "./github-backup.js";

const validateMock = vi.mocked(cron.validate);
const scheduleMock = vi.mocked(cron.schedule);
const runMock = vi.mocked(runGithubBackup);

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const OPTS = {
  schedule: "20 3 * * *",
  github: { repo: "x/y", ref: "main", token: "t" },
  r2: {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucket: "hs-backup",
  },
};

beforeEach(() => {
  validateMock.mockReset();
  scheduleMock.mockReset();
  runMock.mockReset();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  stopGithubBackupCron();
});
afterEach(() => {
  stopGithubBackupCron();
});

describe("startGithubBackupCron", () => {
  it("invalid schedule → error log", () => {
    validateMock.mockReturnValue(false);
    startGithubBackupCron({ ...OPTS, schedule: "bad" });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("valid config schedules with timezone=UTC", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startGithubBackupCron(OPTS);
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "UTC" });
  });
});

describe("runGithubBackupOnce", () => {
  it("forwards repo+r2 to runGithubBackup", async () => {
    runMock.mockResolvedValueOnce({ key: "k", bytes: 50_000, durationMs: 5 });
    await runGithubBackupOnce(OPTS);
    expect(runMock).toHaveBeenCalledWith({ github: OPTS.github, r2: OPTS.r2 });
  });

  it("swallows errors with a FAILED log", async () => {
    runMock.mockRejectedValueOnce(new Error("tarball fetch boom"));
    await runGithubBackupOnce(OPTS);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED/));
  });
});
