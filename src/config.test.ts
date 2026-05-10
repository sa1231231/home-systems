import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./config.js";

describe("ConfigSchema", () => {
  it("accepts a fully populated env", () => {
    const parsed = ConfigSchema.parse({
      PORT: "8080",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@host:5432/db",
    });
    expect(parsed).toMatchObject({
      PORT: 8080,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@host:5432/db",
    });
  });

  it("defaults PORT to 3000 and NODE_ENV to development", () => {
    const parsed = ConfigSchema.parse({
      DATABASE_URL: "postgresql://u:p@host:5432/db",
    });
    expect(parsed.PORT).toBe(3000);
    expect(parsed.NODE_ENV).toBe("development");
  });

  it("rejects missing DATABASE_URL", () => {
    expect(() => ConfigSchema.parse({})).toThrow(/DATABASE_URL/);
  });

  it("rejects empty DATABASE_URL", () => {
    expect(() => ConfigSchema.parse({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("rejects unknown NODE_ENV values", () => {
    expect(() =>
      ConfigSchema.parse({
        NODE_ENV: "staging",
        DATABASE_URL: "postgresql://u:p@host:5432/db",
      }),
    ).toThrow();
  });

  it("rejects non-numeric PORT", () => {
    expect(() =>
      ConfigSchema.parse({
        PORT: "not-a-number",
        DATABASE_URL: "postgresql://u:p@host:5432/db",
      }),
    ).toThrow();
  });

  it("treats Google credentials as optional", () => {
    const parsed = ConfigSchema.parse({
      DATABASE_URL: "postgresql://u:p@host:5432/db",
    });
    expect(parsed.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(parsed.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(parsed.GOOGLE_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(parsed.CRM_SHEET_ID).toBeUndefined();
  });

  it("preserves Google credentials when present", () => {
    const parsed = ConfigSchema.parse({
      DATABASE_URL: "postgresql://u:p@host:5432/db",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "1//refresh",
      CRM_SHEET_ID: "sheet123",
    });
    expect(parsed.GOOGLE_CLIENT_ID).toBe("client-id");
    expect(parsed.GOOGLE_CLIENT_SECRET).toBe("client-secret");
    expect(parsed.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("1//refresh");
    expect(parsed.CRM_SHEET_ID).toBe("sheet123");
  });

  it("defaults the contacts sync cron to disabled with a 7am UTC schedule", () => {
    const parsed = ConfigSchema.parse({ DATABASE_URL: "postgresql://u:p@host:5432/db" });
    expect(parsed.CONTACTS_SYNC_CRON_ENABLED).toBe(false);
    expect(parsed.CONTACTS_SYNC_CRON_SCHEDULE).toBe("0 7 * * *");
  });

  it("enables the cron when the env var is 'true' or '1'", () => {
    expect(
      ConfigSchema.parse({ DATABASE_URL: "x", CONTACTS_SYNC_CRON_ENABLED: "true" }).CONTACTS_SYNC_CRON_ENABLED,
    ).toBe(true);
    expect(
      ConfigSchema.parse({ DATABASE_URL: "x", CONTACTS_SYNC_CRON_ENABLED: "1" }).CONTACTS_SYNC_CRON_ENABLED,
    ).toBe(true);
    expect(
      ConfigSchema.parse({ DATABASE_URL: "x", CONTACTS_SYNC_CRON_ENABLED: "yes" }).CONTACTS_SYNC_CRON_ENABLED,
    ).toBe(false);
  });
});
