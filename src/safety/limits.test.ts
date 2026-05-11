import { afterEach, describe, expect, it } from "vitest";
import {
  DAILY_LIMITS,
  DailyLimitExceededError,
  MemoryCounterStore,
  enforceConfiguredDailyLimit,
  enforceDailyLimit,
  setDefaultCounterStore,
  utcDay,
} from "./limits.js";

afterEach(() => {
  setDefaultCounterStore(null);
});

describe("utcDay", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(utcDay(new Date(Date.UTC(2026, 4, 11, 23, 59)))).toBe("2026-05-11");
    expect(utcDay(new Date(Date.UTC(2026, 0, 2, 0, 0)))).toBe("2026-01-02");
  });

  it("rolls over at UTC midnight regardless of local time", () => {
    // 2026-05-11 23:59 UTC is still 2026-05-11
    expect(utcDay(new Date(Date.UTC(2026, 4, 11, 23, 59, 59)))).toBe("2026-05-11");
    // One second later flips to the next day
    expect(utcDay(new Date(Date.UTC(2026, 4, 12, 0, 0, 0)))).toBe("2026-05-12");
  });
});

describe("MemoryCounterStore", () => {
  it("increments per (operation, day) and returns the new count", async () => {
    const store = new MemoryCounterStore();
    expect(await store.incrementAndGet("x", "2026-05-11")).toBe(1);
    expect(await store.incrementAndGet("x", "2026-05-11")).toBe(2);
    expect(store.get("x", "2026-05-11")).toBe(2);
  });

  it("tracks different operations independently", async () => {
    const store = new MemoryCounterStore();
    await store.incrementAndGet("a", "2026-05-11");
    await store.incrementAndGet("a", "2026-05-11");
    await store.incrementAndGet("b", "2026-05-11");
    expect(store.get("a", "2026-05-11")).toBe(2);
    expect(store.get("b", "2026-05-11")).toBe(1);
  });

  it("tracks different days independently", async () => {
    const store = new MemoryCounterStore();
    await store.incrementAndGet("x", "2026-05-11");
    await store.incrementAndGet("x", "2026-05-11");
    await store.incrementAndGet("x", "2026-05-12");
    expect(store.get("x", "2026-05-11")).toBe(2);
    expect(store.get("x", "2026-05-12")).toBe(1);
  });
});

describe("enforceDailyLimit", () => {
  it("allows calls up to and including the limit", async () => {
    const store = new MemoryCounterStore();
    const now = new Date(Date.UTC(2026, 4, 11));
    for (let i = 0; i < 3; i++) {
      await enforceDailyLimit("op", 3, { store, now });
    }
    expect(store.get("op", "2026-05-11")).toBe(3);
  });

  it("throws DailyLimitExceededError once over the limit", async () => {
    const store = new MemoryCounterStore();
    const now = new Date(Date.UTC(2026, 4, 11));
    await enforceDailyLimit("op", 2, { store, now });
    await enforceDailyLimit("op", 2, { store, now });
    await expect(enforceDailyLimit("op", 2, { store, now })).rejects.toBeInstanceOf(
      DailyLimitExceededError,
    );
  });

  it("populates the error with operation, count, limit, and day", async () => {
    const store = new MemoryCounterStore();
    const now = new Date(Date.UTC(2026, 4, 11));
    await enforceDailyLimit("blast", 1, { store, now });
    try {
      await enforceDailyLimit("blast", 1, { store, now });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DailyLimitExceededError);
      const e = err as DailyLimitExceededError;
      expect(e.operation).toBe("blast");
      expect(e.count).toBe(2);
      expect(e.limit).toBe(1);
      expect(e.day).toBe("2026-05-11");
      expect(e.status).toBe(429);
    }
  });

  it("keeps rejecting after the breach (denied attempts still count)", async () => {
    const store = new MemoryCounterStore();
    const now = new Date(Date.UTC(2026, 4, 11));
    await enforceDailyLimit("op", 1, { store, now });
    await expect(enforceDailyLimit("op", 1, { store, now })).rejects.toThrow();
    await expect(enforceDailyLimit("op", 1, { store, now })).rejects.toThrow();
    expect(store.get("op", "2026-05-11")).toBe(3);
  });

  it("resets quota at the next UTC day", async () => {
    const store = new MemoryCounterStore();
    const day1 = new Date(Date.UTC(2026, 4, 11, 23, 59, 59));
    const day2 = new Date(Date.UTC(2026, 4, 12, 0, 0, 0));
    await enforceDailyLimit("op", 1, { store, now: day1 });
    await expect(enforceDailyLimit("op", 1, { store, now: day1 })).rejects.toThrow();
    await enforceDailyLimit("op", 1, { store, now: day2 });
    expect(store.get("op", "2026-05-11")).toBe(2);
    expect(store.get("op", "2026-05-12")).toBe(1);
  });

  it("rejects nonsensical limits", async () => {
    const store = new MemoryCounterStore();
    await expect(enforceDailyLimit("op", 0, { store })).rejects.toThrow(/positive finite number/);
    await expect(enforceDailyLimit("op", -1, { store })).rejects.toThrow(/positive finite number/);
    await expect(enforceDailyLimit("op", Infinity, { store })).rejects.toThrow(
      /positive finite number/,
    );
  });

  it("falls back to the module default store when none is passed", async () => {
    const store = new MemoryCounterStore();
    setDefaultCounterStore(store);
    const now = new Date(Date.UTC(2026, 4, 11));
    await enforceDailyLimit("xx", 2, { now });
    await enforceDailyLimit("xx", 2, { now });
    await expect(enforceDailyLimit("xx", 2, { now })).rejects.toThrow();
    expect(store.get("xx", "2026-05-11")).toBe(3);
  });
});

describe("enforceConfiguredDailyLimit", () => {
  it("enforces the cap configured in DAILY_LIMITS", async () => {
    const store = new MemoryCounterStore();
    const now = new Date(Date.UTC(2026, 4, 11));
    const op = "email.modify_labels";
    const limit = DAILY_LIMITS[op]!;
    expect(limit).toBeGreaterThan(0);
    for (let i = 0; i < limit; i++) {
      await enforceConfiguredDailyLimit(op, { store, now });
    }
    await expect(enforceConfiguredDailyLimit(op, { store, now })).rejects.toBeInstanceOf(
      DailyLimitExceededError,
    );
  });

  it("is a no-op for ops without a configured cap", async () => {
    const store = new MemoryCounterStore();
    await enforceConfiguredDailyLimit("unknown.op", { store });
    expect(store.get("unknown.op", utcDay())).toBe(0);
  });

  it("has caps registered for every live write operation", () => {
    // Sanity: if a future change wires a new write op, this list should be
    // updated. The list mirrors the currently-wired call sites.
    const wired = [
      "email.modify_labels",
      "contacts.add_csv.groups",
      "contacts.remove_csv.groups",
      "contacts.add_csv.tags",
      "contacts.remove_csv.tags",
      "contacts.set_bool.is_archived",
      "contacts.set_bool.starred",
    ];
    for (const op of wired) {
      expect(DAILY_LIMITS[op]).toBeGreaterThan(0);
    }
  });
});
