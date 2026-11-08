import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { dailyOpCounters } from "../db/schema.js";

export class DailyLimitExceededError extends Error {
  readonly status = 429;
  constructor(
    readonly operation: string,
    readonly count: number,
    readonly limit: number,
    readonly day: string,
  ) {
    super(`daily limit exceeded for "${operation}": ${count}/${limit} on ${day}`);
    this.name = "DailyLimitExceededError";
  }
}

/** UTC date in YYYY-MM-DD format. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type CounterStore = {
  incrementAndGet(operation: string, day: string): Promise<number>;
};

/**
 * Per-operation daily caps. Anything not listed here is treated as
 * uncapped — add explicit entries when you wire a new write op.
 */
export const DAILY_LIMITS: Record<string, number> = {
  "transaction.categorize": 200,
  "contacts.add_csv.groups": 200,
  "contacts.remove_csv.groups": 200,
  "contacts.add_csv.tags": 200,
  "contacts.remove_csv.tags": 200,
  "contacts.assign_group": 200,
  "contacts.set_bool.is_archived": 100,
  "contacts.set_bool.starred": 100,
  "trello.move_card": 50,
  "trello.reorder_card": 200,
  "contacts.review.insert": 100,
  "contacts.review.refresh": 200,
};

export class DbCounterStore implements CounterStore {
  constructor(private readonly database: typeof defaultDb = defaultDb) {}

  async incrementAndGet(operation: string, day: string): Promise<number> {
    const rows = await this.database
      .insert(dailyOpCounters)
      .values({ operation, day, count: 1 })
      .onConflictDoUpdate({
        target: [dailyOpCounters.operation, dailyOpCounters.day],
        set: {
          count: sql`${dailyOpCounters.count} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ count: dailyOpCounters.count });
    return rows[0]!.count;
  }
}

export class MemoryCounterStore implements CounterStore {
  private readonly counts = new Map<string, number>();

  async incrementAndGet(operation: string, day: string): Promise<number> {
    const key = `${operation}\u001f${day}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  get(operation: string, day: string): number {
    return this.counts.get(`${operation}\u001f${day}`) ?? 0;
  }

  reset(): void {
    this.counts.clear();
  }
}

let _defaultStore: CounterStore | null = null;
function getStore(): CounterStore {
  if (!_defaultStore) _defaultStore = new DbCounterStore();
  return _defaultStore;
}

export function setDefaultCounterStore(store: CounterStore | null): void {
  _defaultStore = store;
}

export type EnforceOptions = {
  now?: Date;
  store?: CounterStore;
};

/**
 * Atomically increment today's counter for `operation` and throw
 * DailyLimitExceededError if the resulting count is over `limit`.
 * The counter always increments — denied attempts are counted too, so a
 * runaway loop is visible in the audit table and one breach blocks the rest
 * of the day for that op.
 */
export async function enforceDailyLimit(
  operation: string,
  limit: number,
  options: EnforceOptions = {},
): Promise<void> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`enforceDailyLimit: limit must be a positive finite number, got ${limit}`);
  }
  const now = options.now ?? new Date();
  const store = options.store ?? getStore();
  const day = utcDay(now);
  const count = await store.incrementAndGet(operation, day);
  if (count > limit) {
    throw new DailyLimitExceededError(operation, count, limit, day);
  }
}

/** Convenience wrapper using the cap defined in DAILY_LIMITS for the op. */
export async function enforceConfiguredDailyLimit(
  operation: string,
  options: EnforceOptions = {},
): Promise<void> {
  const limit = DAILY_LIMITS[operation];
  if (limit === undefined) return;
  await enforceDailyLimit(operation, limit, options);
}
