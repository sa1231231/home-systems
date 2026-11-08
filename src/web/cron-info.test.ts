import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from "../config.js";
import { cronInfoForDomain, humanizeSchedule } from "./cron-info.js";

const getConfigMock = vi.mocked(getConfig);

afterEach(() => {
  getConfigMock.mockReset();
});

function setConfig(overrides: Record<string, unknown> = {}): void {
  getConfigMock.mockReturnValue({
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
    setConfig({ TRANSACTION_TRIAGE_CRON_ENABLED: false });
    const info = cronInfoForDomain("transaction");
    expect(info).toMatchObject({
      enabled: false,
      schedule: "0 8 * * *",
      nextRunUtc: null,
      nextRunUtcLabel: null,
      nextRunEtLabel: null,
      parseError: null,
    });
  });

  it("computes a next run for a valid schedule when enabled", () => {
    setConfig();
    const info = cronInfoForDomain("transaction");
    expect(info.enabled).toBe(true);
    expect(info.parseError).toBeNull();
    expect(info.nextRunUtc).toBeInstanceOf(Date);
    expect(info.nextRunUtcLabel).toMatch(/UTC$/);
    expect(info.nextRunEtLabel).toMatch(/ET$/);
  });

  it("returns parseError when the schedule string is invalid", () => {
    setConfig({ TRANSACTION_TRIAGE_CRON_SCHEDULE: "not-a-cron" });
    const info = cronInfoForDomain("transaction");
    expect(info.enabled).toBe(true);
    expect(info.parseError).not.toBeNull();
    expect(info.nextRunUtc).toBeNull();
  });

  it("returns the correct domain for each case", () => {
    setConfig();
    expect(cronInfoForDomain("contact").schedule).toBe("0 6 * * *");
    expect(cronInfoForDomain("transaction").schedule).toBe("0 8 * * *");
    expect(cronInfoForDomain("trello").schedule).toBe("0 5 * * *");
  });

  it("includes a plain-language humanLabel (even when disabled)", () => {
    setConfig({
      TRANSACTION_TRIAGE_CRON_ENABLED: false,
      TRANSACTION_TRIAGE_CRON_SCHEDULE: "0 3 * * *",
    });
    expect(cronInfoForDomain("transaction").humanLabel).toBe("Every day at 3:00 AM ET");
  });

  it("humanLabel is null for a schedule it can't phrase", () => {
    setConfig({ TRELLO_REORDER_CRON_SCHEDULE: "*/5 * * * *" });
    expect(cronInfoForDomain("trello").humanLabel).toBeNull();
  });
});

describe("humanizeSchedule", () => {
  const tz = "America/New_York";

  it("phrases a simple daily schedule", () => {
    expect(humanizeSchedule("0 3 * * *", tz)).toBe("Every day at 3:00 AM ET");
    expect(humanizeSchedule("15 3 * * *", tz)).toBe("Every day at 3:15 AM ET");
  });

  it("handles midnight and noon", () => {
    expect(humanizeSchedule("0 0 * * *", tz)).toBe("Every day at 12:00 AM ET");
    expect(humanizeSchedule("0 12 * * *", tz)).toBe("Every day at 12:00 PM ET");
  });

  it("handles afternoon hours", () => {
    expect(humanizeSchedule("0 11 * * *", tz)).toBe("Every day at 11:00 AM ET");
    expect(humanizeSchedule("0 17 * * *", tz)).toBe("Every day at 5:00 PM ET");
  });

  it("names a single day of week", () => {
    expect(humanizeSchedule("0 8 * * 1", tz)).toBe("Every Monday at 8:00 AM ET");
    expect(humanizeSchedule("0 8 * * 0", tz)).toBe("Every Sunday at 8:00 AM ET");
    expect(humanizeSchedule("0 8 * * 7", tz)).toBe("Every Sunday at 8:00 AM ET");
  });

  it("recognizes weekdays and weekends", () => {
    expect(humanizeSchedule("0 8 * * 1-5", tz)).toBe("Every weekday at 8:00 AM ET");
    expect(humanizeSchedule("0 8 * * 0,6", tz)).toBe("Every weekend at 8:00 AM ET");
  });

  it("lists multiple named days with an Oxford comma", () => {
    expect(humanizeSchedule("30 9 * * 1,3,5", tz)).toBe(
      "Every Monday, Wednesday, and Friday at 9:30 AM ET",
    );
  });

  it("uses the timezone label", () => {
    expect(humanizeSchedule("0 3 * * *", "UTC")).toBe("Every day at 3:00 AM UTC");
  });

  it("returns null for schedules it can't confidently phrase", () => {
    expect(humanizeSchedule("*/5 * * * *", tz)).toBeNull();
    expect(humanizeSchedule("0 3,15 * * *", tz)).toBeNull();
    expect(humanizeSchedule("0 3 1 * *", tz)).toBeNull();
    expect(humanizeSchedule("0 3 * 6 *", tz)).toBeNull();
    expect(humanizeSchedule("not-a-cron", tz)).toBeNull();
  });
});
