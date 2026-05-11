import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from "../../config.js";
import {
  getOAuthClient,
  hasGoogleCreds,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "./oauth.js";

const getConfigMock = vi.mocked(getConfig);

type ConfigShape = Partial<{
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OAUTH_REFRESH_TOKEN: string;
  CRM_SHEET_ID: string;
}>;

function setConfig(overrides: ConfigShape = {}): void {
  getConfigMock.mockReturnValue({
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
    CRM_SHEET_ID: "sheet",
    ...overrides,
  } as never);
}

afterEach(() => {
  getConfigMock.mockReset();
});

describe("hasGoogleCreds", () => {
  it("returns true when all four env vars are set", () => {
    setConfig();
    expect(hasGoogleCreds()).toBe(true);
  });

  it("returns false when GOOGLE_CLIENT_ID is missing", () => {
    setConfig({ GOOGLE_CLIENT_ID: "" });
    expect(hasGoogleCreds()).toBe(false);
  });
  it("returns false when GOOGLE_CLIENT_SECRET is missing", () => {
    setConfig({ GOOGLE_CLIENT_SECRET: "" });
    expect(hasGoogleCreds()).toBe(false);
  });
  it("returns false when GOOGLE_OAUTH_REFRESH_TOKEN is missing", () => {
    setConfig({ GOOGLE_OAUTH_REFRESH_TOKEN: "" });
    expect(hasGoogleCreds()).toBe(false);
  });
  it("returns false when CRM_SHEET_ID is missing", () => {
    setConfig({ CRM_SHEET_ID: "" });
    expect(hasGoogleCreds()).toBe(false);
  });
});

describe("requireGoogleCreds", () => {
  it("returns the typed creds object on success", () => {
    setConfig();
    expect(requireGoogleCreds()).toEqual({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      sheetId: "sheet",
    });
  });

  it("throws MissingGoogleCredsError when any var is empty", () => {
    setConfig({ CRM_SHEET_ID: "" });
    expect(() => requireGoogleCreds()).toThrow(MissingGoogleCredsError);
  });
});

describe("getOAuthClient", () => {
  it("returns a client (and caches it) when creds are configured", () => {
    setConfig();
    const c1 = getOAuthClient();
    const c2 = getOAuthClient();
    expect(c1).toBeTruthy();
    expect(c1).toBe(c2);
  });
});
