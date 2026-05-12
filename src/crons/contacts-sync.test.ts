import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-cron", () => ({
  default: { validate: vi.fn(), schedule: vi.fn() },
}));
vi.mock("../sync/contacts.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/contacts.js")>(
    "../sync/contacts.js",
  );
  return { ...actual, runSync: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return { ...actual, requireGoogleCreds: vi.fn(), getOAuthClient: vi.fn() };
});

import cron from "node-cron";
import { runSync } from "../sync/contacts.js";
import {
  getOAuthClient,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import {
  runContactsSyncOnce,
  startContactsSyncCron,
  stopContactsSyncCron,
} from "./contacts-sync.js";

const validateMock = vi.mocked(cron.validate);
const scheduleMock = vi.mocked(cron.schedule);
const runSyncMock = vi.mocked(runSync);
const requireCredsMock = vi.mocked(requireGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  validateMock.mockReset();
  scheduleMock.mockReset();
  runSyncMock.mockReset();
  requireCredsMock.mockReset();
  oauthMock.mockReset();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  stopContactsSyncCron();
});
afterEach(() => {
  stopContactsSyncCron();
});

describe("startContactsSyncCron", () => {
  it("disabled → no schedule", () => {
    startContactsSyncCron({ enabled: false, schedule: "0 6 * * *" });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("invalid schedule → error log", () => {
    validateMock.mockReturnValue(false);
    startContactsSyncCron({ enabled: true, schedule: "bad" });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("valid schedule → schedules with UTC by default", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startContactsSyncCron({ enabled: true, schedule: "0 6 * * *" });
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "UTC" });
  });

  it("uses provided timezone", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startContactsSyncCron({
      enabled: true,
      schedule: "0 6 * * *",
      timezone: "America/New_York",
    });
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "America/New_York" });
  });
});

describe("runContactsSyncOnce", () => {
  it("calls runSync(client, sheetId, { dryRun: false })", async () => {
    requireCredsMock.mockReturnValue({
      clientId: "x",
      clientSecret: "y",
      refreshToken: "z",
      sheetId: "sheet-1",
    });
    oauthMock.mockReturnValue({} as never);
    runSyncMock.mockResolvedValueOnce({
      plan: {} as never,
      applied: true,
      summary: { inserted: 1, refreshed: 0, unchanged: 0, ambiguous: 0 },
    });
    await runContactsSyncOnce();
    expect(runSyncMock).toHaveBeenCalledOnce();
    const [, sheetId, options] = runSyncMock.mock.calls[0];
    expect(sheetId).toBe("sheet-1");
    expect(options).toMatchObject({ dryRun: false, tab: "dex_contacts" });
  });

  it("silently no-ops on missing creds", async () => {
    requireCredsMock.mockImplementation(() => {
      throw new MissingGoogleCredsError();
    });
    await runContactsSyncOnce();
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it("swallows runSync errors with a FAILED log", async () => {
    requireCredsMock.mockReturnValue({
      clientId: "x",
      clientSecret: "y",
      refreshToken: "z",
      sheetId: "s",
    });
    oauthMock.mockReturnValue({} as never);
    runSyncMock.mockRejectedValueOnce(new Error("sheets 500"));
    await runContactsSyncOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED/));
  });
});
