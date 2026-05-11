import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from "../../config.js";
import {
  hasTrelloCreds,
  MissingTrelloCredsError,
  requireTrelloAuth,
  requireTrelloCreds,
} from "./auth.js";

const getConfigMock = vi.mocked(getConfig);

function setConfig(overrides: Partial<{
  TRELLO_API_KEY: string;
  TRELLO_TOKEN: string;
  TRELLO_BOARD_ID: string;
  TRELLO_WAITING_LIST_ID: string;
  TRELLO_TODAY_LIST_ID: string;
  TRELLO_DAILY_FIELD_ID: string;
  TRELLO_WEEKDAYS_FIELD_ID: string;
  TRELLO_WEEKENDS_FIELD_ID: string;
  CRON_TZ: string;
}> = {}): void {
  getConfigMock.mockReturnValue({
    TRELLO_API_KEY: "key123",
    TRELLO_TOKEN: "tok456",
    TRELLO_BOARD_ID: "board",
    TRELLO_WAITING_LIST_ID: "waitL",
    TRELLO_TODAY_LIST_ID: "todayL",
    TRELLO_DAILY_FIELD_ID: "fd",
    TRELLO_WEEKDAYS_FIELD_ID: "fwd",
    TRELLO_WEEKENDS_FIELD_ID: "fwe",
    CRON_TZ: "America/New_York",
    ...overrides,
  } as never);
}

afterEach(() => {
  getConfigMock.mockReset();
});

describe("hasTrelloCreds", () => {
  it("returns true when all required vars are set", () => {
    setConfig();
    expect(hasTrelloCreds()).toBe(true);
  });
  it("returns false when any required var is missing", () => {
    for (const k of [
      "TRELLO_API_KEY",
      "TRELLO_TOKEN",
      "TRELLO_BOARD_ID",
      "TRELLO_WAITING_LIST_ID",
      "TRELLO_TODAY_LIST_ID",
    ] as const) {
      setConfig({ [k]: "" } as never);
      expect(hasTrelloCreds(), `expected false when ${k} is missing`).toBe(false);
    }
  });
});

describe("requireTrelloCreds", () => {
  it("returns the full creds object on success", () => {
    setConfig();
    expect(requireTrelloCreds()).toEqual({
      apiKey: "key123",
      token: "tok456",
      boardId: "board",
      waitingListId: "waitL",
      todayListId: "todayL",
      dailyFieldId: "fd",
      weekdaysFieldId: "fwd",
      weekendsFieldId: "fwe",
      tz: "America/New_York",
    });
  });

  it("throws listing only the missing names", () => {
    setConfig({ TRELLO_API_KEY: "", TRELLO_BOARD_ID: "" } as never);
    try {
      requireTrelloCreds();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTrelloCredsError);
      expect((err as Error).message).toContain("TRELLO_API_KEY");
      expect((err as Error).message).toContain("TRELLO_BOARD_ID");
      expect((err as Error).message).not.toContain("TRELLO_TOKEN");
    }
  });

  it("custom-field IDs are optional in the result", () => {
    setConfig({ TRELLO_DAILY_FIELD_ID: undefined as never } as never);
    const creds = requireTrelloCreds();
    expect(creds.dailyFieldId).toBeUndefined();
  });
});

describe("requireTrelloAuth", () => {
  it("returns apiKey + token only", () => {
    setConfig();
    expect(requireTrelloAuth()).toEqual({ apiKey: "key123", token: "tok456" });
  });
  it("throws MissingTrelloCredsError when api key or token is missing", () => {
    setConfig({ TRELLO_TOKEN: "" } as never);
    expect(() => requireTrelloAuth()).toThrow(MissingTrelloCredsError);
  });
});
