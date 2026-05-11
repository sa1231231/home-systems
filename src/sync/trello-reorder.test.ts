import { describe, expect, it } from "vitest";
import {
  assignPositions,
  bucketize,
  comparator,
  findDueToday,
  planReorder,
  toLocalDate,
  type CardForOrdering,
  type ReorderContext,
} from "./trello-reorder.js";

const CTX: ReorderContext = {
  today: "2026-05-11",
  tz: "America/New_York",
};

function card(over: Partial<CardForOrdering> & { id: string }): CardForOrdering {
  return {
    idList: "today-list",
    pos: 1000,
    due: null,
    flags: { daily: false, weekdays: false, weekends: false },
    ...over,
  };
}

describe("toLocalDate", () => {
  it("formats UTC midnight as the previous day in America/New_York", () => {
    expect(toLocalDate("2026-05-11T00:00:00Z", "America/New_York")).toBe("2026-05-10");
  });

  it("formats midday UTC as the same day in user TZ", () => {
    expect(toLocalDate("2026-05-11T12:00:00Z", "America/New_York")).toBe("2026-05-11");
  });

  it("respects a different TZ (Asia/Tokyo)", () => {
    expect(toLocalDate("2026-05-11T18:00:00Z", "Asia/Tokyo")).toBe("2026-05-12");
  });
});

describe("bucketize", () => {
  it("bucket 1 for cards with any due date", () => {
    expect(bucketize(card({ id: "a", due: "2026-05-11T12:00:00Z" }), CTX)).toBe(1);
  });

  it("bucket 2 for cards with daily flag", () => {
    expect(bucketize(card({ id: "a", flags: { daily: true, weekdays: false, weekends: false } }), CTX)).toBe(2);
  });

  it("bucket 3 for cards with weekdays flag", () => {
    expect(bucketize(card({ id: "a", flags: { daily: false, weekdays: true, weekends: false } }), CTX)).toBe(3);
  });

  it("bucket 4 for cards with weekends flag", () => {
    expect(bucketize(card({ id: "a", flags: { daily: false, weekdays: false, weekends: true } }), CTX)).toBe(4);
  });

  it("bucket 5 when no due and no flags set", () => {
    expect(bucketize(card({ id: "a" }), CTX)).toBe(5);
  });

  it("due-date wins over any flag", () => {
    const c = card({
      id: "a",
      due: "2026-05-11T12:00:00Z",
      flags: { daily: true, weekdays: true, weekends: true },
    });
    expect(bucketize(c, CTX)).toBe(1);
  });

  it("daily wins over weekdays/weekends when multiple flags set", () => {
    const c = card({ id: "a", flags: { daily: true, weekdays: false, weekends: true } });
    expect(bucketize(c, CTX)).toBe(2);
  });
});

describe("comparator", () => {
  it("sorts by bucket ascending across buckets", () => {
    const due = card({ id: "due", due: "2026-05-11T12:00:00Z" });
    const daily = card({ id: "daily", flags: { daily: true, weekdays: false, weekends: false } });
    const weekends = card({ id: "weekend", flags: { daily: false, weekdays: false, weekends: true } });
    const other = card({ id: "other" });
    const sorted = [other, weekends, daily, due].sort((a, b) => comparator(a, b, CTX));
    expect(sorted.map((c) => c.id)).toEqual(["due", "daily", "weekend", "other"]);
  });

  it("within bucket 1 sorts by due ascending", () => {
    const a = card({ id: "a", due: "2026-05-12T00:00:00Z" });
    const b = card({ id: "b", due: "2026-05-11T00:00:00Z" });
    const c = card({ id: "c", due: "2026-05-13T00:00:00Z" });
    const sorted = [a, b, c].sort((x, y) => comparator(x, y, CTX));
    expect(sorted.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("within other buckets falls back to existing pos (stable)", () => {
    const a = card({ id: "a", pos: 3000, flags: { daily: true, weekdays: false, weekends: false } });
    const b = card({ id: "b", pos: 1000, flags: { daily: true, weekdays: false, weekends: false } });
    const c = card({ id: "c", pos: 2000, flags: { daily: true, weekdays: false, weekends: false } });
    const sorted = [a, b, c].sort((x, y) => comparator(x, y, CTX));
    expect(sorted.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });
});

describe("findDueToday", () => {
  it("picks cards with due date == today in user TZ", () => {
    const a = card({ id: "a", due: "2026-05-11T12:00:00Z" });
    const b = card({ id: "b", due: "2026-05-12T18:00:00Z" });
    const c = card({ id: "c", due: null });
    expect(findDueToday([a, b, c], CTX).map((c) => c.id)).toEqual(["a"]);
  });

  it("also picks overdue cards", () => {
    const a = card({ id: "a", due: "2026-05-05T12:00:00Z" });
    expect(findDueToday([a], CTX).map((c) => c.id)).toEqual(["a"]);
  });

  it("does not pick cards due in the future", () => {
    const a = card({ id: "a", due: "2026-06-01T12:00:00Z" });
    expect(findDueToday([a], CTX)).toEqual([]);
  });
});

describe("assignPositions", () => {
  it("assigns (i+1)*1000 in input order", () => {
    const m = assignPositions(["a", "b", "c"]);
    expect(m.get("a")).toBe(1000);
    expect(m.get("b")).toBe(2000);
    expect(m.get("c")).toBe(3000);
  });
});

describe("planReorder", () => {
  it("produces zero ops on an already-sorted list (idempotent)", () => {
    const cards: CardForOrdering[] = [
      card({ id: "a", idList: "today-list", pos: 1000, due: "2026-05-11T08:00:00Z" }),
      card({ id: "b", idList: "today-list", pos: 2000, flags: { daily: true, weekdays: false, weekends: false } }),
      card({ id: "c", idList: "today-list", pos: 3000, flags: { daily: false, weekdays: true, weekends: false } }),
    ];
    expect(planReorder(cards, [], CTX, "today-list")).toEqual([]);
  });

  it("emits a 'move' op for each incoming Waiting card and a 'reorder' op for shifted cards", () => {
    const todayCards: CardForOrdering[] = [
      card({ id: "old-a", idList: "today-list", pos: 1000, flags: { daily: true, weekdays: false, weekends: false } }),
      card({ id: "old-b", idList: "today-list", pos: 2000, flags: { daily: false, weekdays: true, weekends: false } }),
    ];
    const incoming: CardForOrdering[] = [
      card({ id: "new-1", idList: "waiting-list", pos: 5000, due: "2026-05-11T08:00:00Z" }),
    ];
    const ops = planReorder(todayCards, incoming, CTX, "today-list");
    expect(ops).toEqual([
      {
        cardId: "new-1",
        fromList: "waiting-list",
        fromPos: 5000,
        toList: "today-list",
        toPos: 1000,
        kind: "move",
      },
      {
        cardId: "old-a",
        fromList: "today-list",
        fromPos: 1000,
        toList: "today-list",
        toPos: 2000,
        kind: "reorder",
      },
      {
        cardId: "old-b",
        fromList: "today-list",
        fromPos: 2000,
        toList: "today-list",
        toPos: 3000,
        kind: "reorder",
      },
    ]);
  });

  it("dedupes when a card already in Today also appears in incoming (incoming wins)", () => {
    const todayCards: CardForOrdering[] = [
      card({ id: "dup", idList: "today-list", pos: 1000 }),
    ];
    const incoming: CardForOrdering[] = [
      card({ id: "dup", idList: "waiting-list", pos: 4500, due: "2026-05-11T08:00:00Z" }),
    ];
    const ops = planReorder(todayCards, incoming, CTX, "today-list");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ cardId: "dup", fromList: "waiting-list", kind: "move" });
  });

  it("re-runs after a successful first pass produce no ops", () => {
    const initial: CardForOrdering[] = [
      card({ id: "a", idList: "today-list", pos: 4444 }),
      card({ id: "b", idList: "today-list", pos: 3333, flags: { daily: true, weekdays: false, weekends: false } }),
      card({ id: "c", idList: "today-list", pos: 9999, flags: { daily: false, weekdays: true, weekends: false } }),
    ];
    const firstOps = planReorder(initial, [], CTX, "today-list");
    expect(firstOps.length).toBeGreaterThan(0);
    const updated = initial.map((c) => {
      const op = firstOps.find((o) => o.cardId === c.id);
      return op ? { ...c, idList: op.toList, pos: op.toPos } : c;
    });
    expect(planReorder(updated, [], CTX, "today-list")).toEqual([]);
  });
});
