/**
 * Pure ordering logic for the Trello "Today" list automation.
 *
 * No DB. No API calls. No side effects. Everything in here is unit-testable
 * with plain objects so the runner (trello-runner.ts) can stay thin.
 */

export type CardForOrdering = {
  id: string;
  idList: string;
  pos: number;
  /** ISO-8601 timestamp string or null. */
  due: string | null;
  /** Custom-field checkbox flags, derived from Trello customFieldItems. */
  flags: {
    daily: boolean;
    weekdays: boolean;
    weekends: boolean;
  };
};

export type ReorderContext = {
  /** YYYY-MM-DD in the user's local timezone. */
  today: string;
  /** IANA TZ identifier, e.g. "America/New_York". */
  tz: string;
};

export type Bucket = 1 | 2 | 3 | 4 | 5;

export type UpdateOp = {
  cardId: string;
  fromList: string;
  fromPos: number;
  toList: string;
  toPos: number;
  /** "move" = idList changes (often also pos). "reorder" = same list, pos changes. */
  kind: "move" | "reorder";
};

/** Format a Date or ISO string as YYYY-MM-DD in the given IANA timezone. */
export function toLocalDate(when: string | Date, tz: string): string {
  const d = typeof when === "string" ? new Date(when) : when;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Bucket assignment:
 *   1 = has a due date (sorted by due ascending within bucket)
 *   2 = Daily checkbox is checked
 *   3 = Weekdays checkbox is checked
 *   4 = Weekends checkbox is checked
 *   5 = anything else (preserve existing relative order)
 *
 * Earlier buckets win when a card matches multiple criteria, e.g. a card
 * with both a `due` and the Daily checkbox lands in bucket 1.
 */
export function bucketize(card: CardForOrdering, _ctx: ReorderContext): Bucket {
  if (card.due) return 1;
  if (card.flags.daily) return 2;
  if (card.flags.weekdays) return 3;
  if (card.flags.weekends) return 4;
  return 5;
}

/**
 * Total order over cards:
 *   primary: bucket ascending
 *   secondary (bucket 1 only): due-date ascending
 *   tertiary: existing pos ascending (stable across reruns)
 */
export function comparator(a: CardForOrdering, b: CardForOrdering, ctx: ReorderContext): number {
  const ba = bucketize(a, ctx);
  const bb = bucketize(b, ctx);
  if (ba !== bb) return ba - bb;
  if (ba === 1 && a.due && b.due && a.due !== b.due) {
    return a.due < b.due ? -1 : 1;
  }
  return a.pos - b.pos;
}

/**
 * Pick cards from `waiting` whose due date is today or earlier (in user TZ).
 * Overdue cards still in Waiting are also surfaced — the right behavior is
 * to pull them into Today rather than leave them stranded.
 */
export function findDueToday(waiting: CardForOrdering[], ctx: ReorderContext): CardForOrdering[] {
  return waiting.filter((c) => {
    if (!c.due) return false;
    return toLocalDate(c.due, ctx.tz) <= ctx.today;
  });
}

/**
 * Given the desired ordered list, assign monotonic pos values with a 1000-step
 * gap so manual Trello edits between cron runs don't collide.
 */
export function assignPositions(orderedCardIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  orderedCardIds.forEach((id, i) => out.set(id, (i + 1) * 1000));
  return out;
}

/**
 * The full plan: combine current Today cards + cards being pulled in from
 * Waiting, sort the union, and emit UpdateOp[] only for cards whose
 * (list, pos) would differ. Idempotent: running twice on the same input
 * produces an empty op list the second time.
 */
export function planReorder(
  todayCards: CardForOrdering[],
  incoming: CardForOrdering[],
  ctx: ReorderContext,
  todayListId: string,
): UpdateOp[] {
  const incomingIds = new Set(incoming.map((c) => c.id));
  const combined: CardForOrdering[] = [
    ...todayCards.filter((c) => !incomingIds.has(c.id)),
    ...incoming,
  ];
  const sorted = [...combined].sort((a, b) => comparator(a, b, ctx));
  const targetPos = assignPositions(sorted.map((c) => c.id));

  const ops: UpdateOp[] = [];
  for (const c of sorted) {
    const toPos = targetPos.get(c.id)!;
    const movingList = c.idList !== todayListId;
    const movingPos = c.pos !== toPos;
    if (!movingList && !movingPos) continue;
    ops.push({
      cardId: c.id,
      fromList: c.idList,
      fromPos: c.pos,
      toList: todayListId,
      toPos,
      kind: movingList ? "move" : "reorder",
    });
  }
  return ops;
}
