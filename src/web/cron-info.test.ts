import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from "../config.js";
import { cronInfoForDomain } from "./cron-info.js";

const getConfigMock = vi.mocked(getConfig);

afterEach(() => {
  getConfigMock.mockReset();
});

function setConfig(overrides: Record<string, unknown> = {}): void {
  getConfigMock.mockReturnValue({
    EMAIL_TRIAGE_CRON_ENABLED: true,
    EMAIL_TRIAGE_CRON_SCHEDULE: "0 7 * * *",
    CONTACTS_SYNC_CRON_ENABLED: true,
    CONTACTS_SYNC_CRON_SCHEDULE: "0 6 * * *",
    TRANSACTION_TRIAGE_CRON_ENABLED: true,
    TRANSACTION_TRIAGE_CRON_SCHEDULE: "0 8 * * *",
    TRELLO_REORDER_CRON_ENABLED: true,
    TRELLO_REORDER_CRON_SCHEDULE: "0 5 * * *",
    CRON_TZ: "America/New_York",
    ...overrides,
  } as never);
}

describe("cronInfoForDomain", () => {
  it("returns enabled=false with no nextRun when disabled", () => {
    setConfig({ EMAIL_TRIAGE_CRON_ENABLED: false });
    const info = cronInfoForDomain("email");
    expect(info).toMatchObject({
      enabled: false,
      schedule: "0 7 * * *",
      nextRunUtc: null,
      nextRunUtcLabel: null,
      nextRunEtLabel: null,
      parseError: null,
    });
  });

  it("computes a next run for a valid schedule when enabled", () => {
    setConfig();
    const info = cronInfoForDomain("email");
    expect(info.enabled).toBe(true);
    expect(info.parseError).toBeNull();
    expect(info.nextRunUtc).toBeInstanceOf(Date);
    expect(info.nextRunUtcLabel).toMatch(/UTC$/);
    expect(info.nextRunEtLabel).toMatch(/ET$/);
  });

  it("returns parseError when the schedule string is invalid", () => {
    setConfig({ EMAIL_TRIAGE_CRON_SCHEDULE: "not-a-cron" });
    const info = cronInfoForDomain("email");
    expect(info.enabled).toBe(true);
    expect(info.parseError).not.toBeNull();
    expect(info.nextRunUtc).toBeNull();
  });

  it("returns the correct domain for each case", () => {
    setConfig();
    expect(cronInfoForDomain("email").schedule).toBe("0 7 * * *");
    expect(cronInfoForDomain("contact").schedule).toBe("0 6 * * *");
    expect(cronInfoForDomain("transaction").schedule).toBe("0 8 * * *");
    expect(cronInfoForDomain("trello").schedule).toBe("0 5 * * *");
  });
});
