import { describe, expect, it } from "vitest";
import { NoReverserError, ReverserRegistry } from "./reversers.js";
import type { ChangelogRow } from "./types.js";

function row(overrides: Partial<ChangelogRow> = {}): ChangelogRow {
  return {
    id: 1,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    caller: "test",
    sessionId: "sess-1",
    operation: "test.op",
    targetKind: "contact",
    targetId: "people/c1",
    intent: null,
    beforeState: {},
    afterState: {},
    externalTarget: null,
    status: "success",
    error: null,
    undoneBy: null,
    ...overrides,
  };
}

describe("ReverserRegistry", () => {
  it("registers and dispatches by operation", async () => {
    const reg = new ReverserRegistry();
    const seen: ChangelogRow[] = [];
    reg.register("foo.bar", async (e) => {
      seen.push(e);
    });
    expect(reg.has("foo.bar")).toBe(true);
    await reg.reverse(row({ operation: "foo.bar" }));
    expect(seen).toHaveLength(1);
    expect(seen[0].operation).toBe("foo.bar");
  });

  it("throws NoReverserError for unregistered operations", async () => {
    const reg = new ReverserRegistry();
    await expect(reg.reverse(row({ operation: "missing" }))).rejects.toBeInstanceOf(NoReverserError);
  });

  it("rejects duplicate registration", () => {
    const reg = new ReverserRegistry();
    reg.register("dup", async () => {});
    expect(() => reg.register("dup", async () => {})).toThrow(/already registered/);
  });
});
