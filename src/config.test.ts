import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./config.js";

describe("ConfigSchema", () => {
  it("accepts a fully populated env", () => {
    const parsed = ConfigSchema.parse({
      PORT: "8080",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@host:5432/db",
    });
    expect(parsed).toEqual({
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
});
