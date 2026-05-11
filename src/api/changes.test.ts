import { describe, expect, it } from "vitest";
import { windowStartFor24h } from "./changes.js";

describe("windowStartFor24h", () => {
  it("returns now minus 24 hours", () => {
    const now = new Date(Date.UTC(2026, 4, 11, 12, 0, 0));
    expect(windowStartFor24h(now).toISOString()).toBe("2026-05-10T12:00:00.000Z");
  });

  it("crosses month boundaries", () => {
    const now = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
    expect(windowStartFor24h(now).toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("crosses year boundaries", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(windowStartFor24h(now).toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });

  it("defaults to current time when no argument is passed", () => {
    const before = Date.now();
    const start = windowStartFor24h().getTime();
    const after = Date.now();
    expect(start).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(start).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);
  });
});
