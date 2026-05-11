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

  it("defaults the backup cron to disabled with a 3:15am UTC schedule", () => {
    const parsed = ConfigSchema.parse({ DATABASE_URL: "postgresql://u:p@host:5432/db" });
    expect(parsed.BACKUP_CRON_ENABLED).toBe(false);
    expect(parsed.BACKUP_CRON_SCHEDULE).toBe("15 3 * * *");
    expect(parsed.R2_ACCOUNT_ID).toBeUndefined();
    expect(parsed.R2_BUCKET).toBeUndefined();
  });

  it("defaults UI_AUTH_ENABLED to true and leaves password/secret optional", () => {
    const parsed = ConfigSchema.parse({ DATABASE_URL: "x" });
    expect(parsed.UI_AUTH_ENABLED).toBe(true);
    expect(parsed.UI_PASSWORD).toBeUndefined();
    expect(parsed.SESSION_SECRET).toBeUndefined();
  });

  it("disables UI auth only when explicitly set to 'false' or '0'", () => {
    expect(ConfigSchema.parse({ DATABASE_URL: "x", UI_AUTH_ENABLED: "false" }).UI_AUTH_ENABLED).toBe(
      false,
    );
    expect(ConfigSchema.parse({ DATABASE_URL: "x", UI_AUTH_ENABLED: "0" }).UI_AUTH_ENABLED).toBe(
      false,
    );
    expect(
      ConfigSchema.parse({ DATABASE_URL: "x", UI_AUTH_ENABLED: "true" }).UI_AUTH_ENABLED,
    ).toBe(true);
    expect(ConfigSchema.parse({ DATABASE_URL: "x" }).UI_AUTH_ENABLED).toBe(true);
  });

  it("requires UI_PASSWORD to be at least 8 characters when set", () => {
    expect(() =>
      ConfigSchema.parse({ DATABASE_URL: "x", UI_PASSWORD: "short" }),
    ).toThrow(/UI_PASSWORD/);
  });

  it("requires SESSION_SECRET to be at least 32 characters when set", () => {
    expect(() =>
      ConfigSchema.parse({ DATABASE_URL: "x", SESSION_SECRET: "short" }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("preserves R2 credentials when present", () => {
    const parsed = ConfigSchema.parse({
      DATABASE_URL: "x",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: "home-systems-backups",
      BACKUP_CRON_ENABLED: "true",
    });
    expect(parsed.R2_ACCOUNT_ID).toBe("acct");
    expect(parsed.R2_ACCESS_KEY_ID).toBe("ak");
    expect(parsed.R2_SECRET_ACCESS_KEY).toBe("sk");
    expect(parsed.R2_BUCKET).toBe("home-systems-backups");
    expect(parsed.BACKUP_CRON_ENABLED).toBe(true);
  });
});
