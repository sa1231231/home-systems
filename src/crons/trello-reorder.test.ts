import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-cron", () => ({
  default: { validate: vi.fn(), schedule: vi.fn() },
}));
vi.mock("../sync/trello-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/trello-runner.js")>(
    "../sync/trello-runner.js",
  );
  return { ...actual, runTrelloReorderOnce: vi.fn() };
});
vi.mock("../integrations/trello/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/trello/auth.js")>(
    "../integrations/trello/auth.js",
  );
  return { ...actual, requireTrelloCreds: vi.fn() };
});
vi.mock("../integrations/trello/client.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/trello/client.js")>(
    "../integrations/trello/client.js",
  );
  return { ...actual, makeTrelloClient: vi.fn() };
});

import cron from "node-cron";
import { runTrelloReorderOnce as runOnceLib } from "../sync/trello-runner.js";
import {
  MissingTrelloCredsError,
  requireTrelloCreds,
} from "../integrations/trello/auth.js";
import { makeTrelloClient } from "../integrations/trello/client.js";
import {
  runTrelloReorderOnceFromCron,
  startTrelloReorderCron,
  stopTrelloReorderCron,
} from "./trello-reorder.js";

const validateMock = vi.mocked(cron.validate);
const scheduleMock = vi.mocked(cron.schedule);
const runOnceMock = vi.mocked(runOnceLib);
const requireCredsMock = vi.mocked(requireTrelloCreds);
const makeClientMock = vi.mocked(makeTrelloClient);

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const CREDS = {
  apiKey: "k",
  token: "t",
  boardId: "b",
  waitingListId: "lw",
  todayListId: "lt",
  tz: "America/New_York",
};

beforeEach(() => {
  validateMock.mockReset();
  scheduleMock.mockReset();
  runOnceMock.mockReset();
  requireCredsMock.mockReset();
  makeClientMock.mockReset();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  stopTrelloReorderCron();
});
afterEach(() => {
  stopTrelloReorderCron();
});

describe("startTrelloReorderCron", () => {
  it("disabled → no schedule", () => {
    startTrelloReorderCron({ enabled: false, schedule: "0 5 * * *" });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("invalid schedule → error log", () => {
    validateMock.mockReturnValue(false);
    startTrelloReorderCron({ enabled: true, schedule: "bad" });
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("valid config schedules with the configured timezone", () => {
    validateMock.mockReturnValue(true);
    scheduleMock.mockReturnValue({ stop: vi.fn() } as never);
    startTrelloReorderCron({
      enabled: true,
      schedule: "0 5 * * *",
      timezone: "America/New_York",
    });
    expect(scheduleMock.mock.calls[0][2]).toEqual({ timezone: "America/New_York" });
  });
});

describe("runTrelloReorderOnceFromCron", () => {
  it("invokes runTrelloReorderOnce with dryRun=false + cron caller", async () => {
    requireCredsMock.mockReturnValue(CREDS);
    const client = { _fake: true } as never;
    makeClientMock.mockReturnValue(client);
    runOnceMock.mockResolvedValueOnce({
      today: "2026-05-11",
      planned: 0,
      moved: 0,
      reordered: 0,
      unchanged: 0,
      errors: [],
      ops: [],
    });
    await runTrelloReorderOnceFromCron();
    const [, , opts] = runOnceMock.mock.calls[0];
    expect(opts.dryRun).toBe(false);
    expect(opts.caller).toBe("cron:trello.reorder");
    expect(makeClientMock).toHaveBeenCalledWith({ apiKey: "k", token: "t" });
  });

  it("logs per-card errors when present", async () => {
    requireCredsMock.mockReturnValue(CREDS);
    makeClientMock.mockReturnValue({} as never);
    runOnceMock.mockResolvedValueOnce({
      today: "2026-05-11",
      planned: 1,
      moved: 0,
      reordered: 0,
      unchanged: 0,
      errors: [{ cardId: "c1", error: "trello 429" }],
      ops: [],
    });
    await runTrelloReorderOnceFromCron();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/card=c1.*trello 429/),
    );
  });

  it("silently no-ops on MissingTrelloCredsError", async () => {
    requireCredsMock.mockImplementation(() => {
      throw new MissingTrelloCredsError([]);
    });
    await runTrelloReorderOnceFromCron();
    expect(runOnceMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/skipped: credentials/),
    );
  });

  it("swallows generic errors with a FAILED log", async () => {
    requireCredsMock.mockReturnValue(CREDS);
    makeClientMock.mockReturnValue({} as never);
    runOnceMock.mockRejectedValueOnce(new Error("kaboom"));
    await runTrelloReorderOnceFromCron();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/FAILED/));
  });
});
