import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-cron", () => ({
  default: {
    validate: vi.fn(),
    schedule: vi.fn(),
  },
}));
vi.mock("../sync/email-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/email-triage.js")>(
    "../sync/email-triage.js",
  );
  return { ...actual, triageAllAccounts: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return {
    ...actual,
    requireGoogleCreds: vi.fn(),
    getOAuthClient: vi.fn(),
  };
});

import cron from "node-cron";
import { triageAllAccounts } from "../sync/email-triage.js";
import {
  getOAuthClient,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import {
  runEmailTriageOnce,
  startEmailTriageCron,
  stopEmailTriageCron,
} from "./email-triage.js";

const validateMock = vi.mocked(cron.validate);
const scheduleMock = vi.mocked(cron.schedule);
const triageMock = vi.mocked(triageAllAccounts);
const requireCredsMock = vi.mocked(requireGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  validateMock.mockReset();
  scheduleMock.mockReset();
  triageMock.mockReset();
  requireCredsMock.mockReset();
  oauthMock.mockReset();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  stopEmailTriageCron(); // clear any lingering state
});

afterEach(() => {
  stopEmailTriageCron();
});

describe("startEmailTriageCron", () => {
  it("logs and returns when disabled", () => {
    startEmailTriageCron({ enabled: false, schedule: "0 7 * * *" });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("logs an error and skips scheduling on invalid cron expression", () => {
    validateMock.mockReturnValue(false);
    startEmailTriageCron({ enabled: true, schedule: "garbage" });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("schedules the cron with the configured tz, defaulting to UTC", () => {
    validateMock.mockReturnValue(true);
    const stopFn = vi.fn();
    scheduleMock.mockReturnValue({ stop: stopFn } as never);
    startEmailTriageCron({ enabled: true, schedule: "0 7 * * *" });
    expect(scheduleMock).toHaveBeenCalledOnce();
    const [scheduleStr, , options] = scheduleMock.mock.calls[0];
    expect(scheduleStr).toBe("0 7 * * *");
    expect(options).toEqual({ timezone: "UTC" });
  });

  it("uses the provided timezone when specified", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startEmailTriageCron({
      enabled: true,
      schedule: "0 7 * * *",
      timezone: "America/New_York",
    });
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "America/New_York" });
  });

  it("stop() invokes the scheduled task's stop()", () => {
    validateMock.mockReturnValue(true);
    const stopFn = vi.fn();
    scheduleMock.mockReturnValue({ stop: stopFn } as never);
    startEmailTriageCron({ enabled: true, schedule: "0 7 * * *" });
    stopEmailTriageCron();
    expect(stopFn).toHaveBeenCalled();
  });
});

describe("runEmailTriageOnce", () => {
  it("calls triageAllAccounts with a 'cron:' session id", async () => {
    requireCredsMock.mockReturnValue({
      clientId: "x",
      clientSecret: "y",
      refreshToken: "z",
      sheetId: "s",
    });
    oauthMock.mockReturnValue({} as never);
    triageMock.mockResolvedValueOnce({
      total: 0,
      matched: 0,
      queued: 0,
      skipped: 0,
      errors: 0,
      items: [],
      accounts: [],
    });
    await runEmailTriageOnce();
    expect(triageMock).toHaveBeenCalledOnce();
    const [opts] = triageMock.mock.calls[0];
    expect(opts.sessionId.startsWith("cron:")).toBe(true);
    expect(opts.caller).toBe("cron:email-triage");
  });

  it("silently no-ops on missing google creds", async () => {
    requireCredsMock.mockImplementation(() => {
      throw new MissingGoogleCredsError();
    });
    await runEmailTriageOnce();
    expect(triageMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/skipped: google credentials/),
    );
  });

  it("logs and swallows arbitrary errors", async () => {
    requireCredsMock.mockReturnValue({
      clientId: "x",
      clientSecret: "y",
      refreshToken: "z",
      sheetId: "s",
    });
    oauthMock.mockReturnValue({} as never);
    triageMock.mockRejectedValueOnce(new Error("gmail 503"));
    await runEmailTriageOnce(); // does not throw
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED/));
  });
});
