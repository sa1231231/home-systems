import { describe, expect, it } from "vitest";
import { groupBySession, type ChangelogRowLike } from "./session-groups.js";

function row(over: Partial<ChangelogRowLike> & { id: number; sessionId: string }): ChangelogRowLike {
  return {
    createdAt: new Date("2026-05-12T12:00:00Z"),
    caller: "test",
    operation: "test.op",
    targetKind: "thing",
    targetId: "t1",
    status: "success",
    undoneBy: null,
    ...over,
  };
}

describe("groupBySession", () => {
  it("groups rows by session_id", () => {
    const groups = groupBySession([
      row({ id: 1, sessionId: "s1" }),
      row({ id: 2, sessionId: "s2" }),
      row({ id: 3, sessionId: "s1" }),
    ]);
    expect(groups).toHaveLength(2);
    const ids = groups.map((g) => g.sessionId).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("counts operations within a session", () => {
    const [g] = groupBySession([
      row({ id: 1, sessionId: "s", operation: "x.do" }),
      row({ id: 2, sessionId: "s", operation: "x.do" }),
      row({ id: 3, sessionId: "s", operation: "x.undo" }),
    ]);
    expect(g.byOperation).toEqual({ "x.do": 2, "x.undo": 1 });
    expect(g.totalRows).toBe(3);
  });

  it("classifies status counts (reversible / undone / failed)", () => {
    const [g] = groupBySession([
      row({ id: 1, sessionId: "s", status: "success", undoneBy: null }),
      row({ id: 2, sessionId: "s", status: "success", undoneBy: 99 }),
      row({ id: 3, sessionId: "s", status: "failed" }),
    ]);
    expect(g.reversibleCount).toBe(1);
    expect(g.undoneCount).toBe(1);
    expect(g.failedCount).toBe(1);
  });

  it("sorts groups by startedAt descending (newest job first)", () => {
    const groups = groupBySession([
      row({ id: 1, sessionId: "old", createdAt: new Date("2026-05-01T00:00:00Z") }),
      row({ id: 2, sessionId: "new", createdAt: new Date("2026-05-10T00:00:00Z") }),
    ]);
    expect(groups.map((g) => g.sessionId)).toEqual(["new", "old"]);
  });

  it("collects up to 3 unique sample targets per session", () => {
    const [g] = groupBySession([
      row({ id: 1, sessionId: "s", targetKind: "card", targetId: "a" }),
      row({ id: 2, sessionId: "s", targetKind: "card", targetId: "b" }),
      row({ id: 3, sessionId: "s", targetKind: "card", targetId: "a" }),
      row({ id: 4, sessionId: "s", targetKind: "card", targetId: "c" }),
      row({ id: 5, sessionId: "s", targetKind: "card", targetId: "d" }),
    ]);
    expect(g.sampleTargets).toHaveLength(3);
    expect(g.sampleTargets.map((t) => t.targetId)).toEqual(["a", "b", "c"]);
  });
});
