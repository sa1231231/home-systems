import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-cron", () => ({
  default: { validate: vi.fn(), schedule: vi.fn() },
}));
vi.mock("../sync/transaction-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/transaction-triage.js")>(
    "../sync/transaction-triage.js",
  );
  return { ...actual, triageTransactions: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return { ...actual, requireGoogleCreds: vi.fn(), getOAuthClient: vi.fn() };
});

import cron from "node-cron";
import { triageTransactions } from "../sync/transaction-triage.js";
import {
  getOAuthClient,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import {
  runTransactionTriageOnce,
  startTransactionTriageCron,
  stopTransactionTriageCron,
} from "./transaction-triage.js";

const validateMock = vi.mocked(cron.validate);
const scheduleMock = vi.mocked(cron.schedule);
const triageMock = vi.mocked(triageTransactions);
const requireCredsMock = vi.mocked(requireGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const TARGET = {
  sheetId: "sheet-1",
  transactionsTab: "Transactions",
  categoriesTab: "Categories",
};

beforeEach(() => {
  validateMock.mockReset();
  scheduleMock.mockReset();
  triageMock.mockReset();
  requireCredsMock.mockReset();
  oauthMock.mockReset();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  stopTransactionTriageCron();
});
afterEach(() => {
  stopTransactionTriageCron();
});

describe("startTransactionTriageCron", () => {
  it("disabled → no schedule", () => {
    startTransactionTriageCron({
      enabled: false,
      schedule: "0 8 * * *",
      limit: 50,
      target: TARGET,
    });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("missing target → no schedule", () => {
    startTransactionTriageCron({
      enabled: true,
      schedule: "0 8 * * *",
      limit: 50,
      target: undefined,
    });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("TRANSACTIONS_SHEET_ID is not configured"),
    );
  });

  it("invalid schedule → error log", () => {
    validateMock.mockReturnValue(false);
    startTransactionTriageCron({
      enabled: true,
      schedule: "bad",
      limit: 50,
      target: TARGET,
    });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("valid config schedules with the configured tz", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startTransactionTriageCron({
      enabled: true,
      schedule: "0 8 * * *",
      limit: 50,
      target: TARGET,
      timezone: "America/New_York",
    });
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "America/New_York" });
  });
});

describe("runTransactionTriageOnce", () => {
  it("calls triageTransactions with the configured target + limit", async () => {
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
    });
    await runTransactionTriageOnce({ limit: 33, target: TARGET });
    expect(triageMock).toHaveBeenCalledOnce();
    const [, opts] = triageMock.mock.calls[0];
    expect(opts.limit).toBe(33);
    expect(opts.target).toBe(TARGET);
    expect(opts.caller).toBe("cron:transaction-triage");
  });

  it("silently no-ops on missing creds", async () => {
    requireCredsMock.mockImplementation(() => {
      throw new MissingGoogleCredsError();
    });
    await runTransactionTriageOnce({ limit: 10, target: TARGET });
    expect(triageMock).not.toHaveBeenCalled();
  });

  it("swallows triage errors with a FAILED log", async () => {
    requireCredsMock.mockReturnValue({
      clientId: "x",
      clientSecret: "y",
      refreshToken: "z",
      sheetId: "s",
    });
    oauthMock.mockReturnValue({} as never);
    triageMock.mockRejectedValueOnce(new Error("boom"));
    await runTransactionTriageOnce({ limit: 10, target: TARGET });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED/));
  });
});
