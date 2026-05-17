import { and, desc, eq, gte } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { triageRuns } from "../db/schema.js";

export type TriageRunDomain = "email" | "transaction" | "contact" | "trello";

export type TriageRunRow = typeof triageRuns.$inferSelect;

/**
 * Mark the start of a triage run and return its id. The row is persisted as
 * "running"; the caller is responsible for follow-up `completeRun` or `failRun`.
 */
export async function startRun(
  domain: TriageRunDomain,
  sessionId: string,
  caller: string,
  database: typeof defaultDb = defaultDb,
): Promise<number> {
  const [row] = await database
    .insert(triageRuns)
    .values({ domain, sessionId, caller })
    .returning({ id: triageRuns.id });
  return row.id;
}

export async function completeRun(
  id: number,
  summary: unknown,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  await database
    .update(triageRuns)
    .set({
      status: "success",
      summary: summary as never,
      completedAt: new Date(),
    })
    .where(eq(triageRuns.id, id));
}

export async function failRun(
  id: number,
  err: unknown,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await database
    .update(triageRuns)
    .set({
      status: "error",
      error: message.slice(0, 4000),
      completedAt: new Date(),
    })
    .where(eq(triageRuns.id, id));
}

/**
 * Wrap an async run with a triage_runs row. Records started_at on entry,
 * completed_at + summary on success, error on throw. The inner error is
 * re-raised so callers can handle it as usual.
 */
export async function withTriageRun<T>(
  domain: TriageRunDomain,
  sessionId: string,
  caller: string,
  fn: () => Promise<T>,
  database: typeof defaultDb = defaultDb,
): Promise<T> {
  const id = await startRun(domain, sessionId, caller, database);
  try {
    const result = await fn();
    await completeRun(id, result as unknown, database);
    return result;
  } catch (err) {
    await failRun(id, err, database);
    throw err;
  }
}

/** A run still "running" past this is treated as dead (its process vanished). */
const STUCK_RUN_TIMEOUT_MS = 15 * 60 * 1000;

const STUCK_RUN_MESSAGE = "run did not finish — process restarted or timed out";

/**
 * Latest run for a domain within the lookback window. Used to drive the
 * "currently running / just finished" banner on each tab. Default lookback
 * is 1 hour — runs older than that aren't surfaced.
 *
 * Self-heals a stuck run: if the latest run is still "running" well past the
 * point a real run would finish, its process died without writing a terminal
 * status (e.g. a redeploy restarted the container mid-run). Mark it errored
 * so the "running" banner doesn't hang forever.
 */
export async function latestRunFor(
  domain: TriageRunDomain,
  options: { lookbackMs?: number; database?: typeof defaultDb } = {},
): Promise<TriageRunRow | null> {
  const lookbackMs = options.lookbackMs ?? 60 * 60 * 1000;
  const database = options.database ?? defaultDb;
  const since = new Date(Date.now() - lookbackMs);
  const [row] = await database
    .select()
    .from(triageRuns)
    .where(and(eq(triageRuns.domain, domain), gte(triageRuns.startedAt, since)))
    .orderBy(desc(triageRuns.id))
    .limit(1);
  if (!row) return null;
  if (
    row.status === "running" &&
    Date.now() - new Date(row.startedAt).getTime() > STUCK_RUN_TIMEOUT_MS
  ) {
    await failRun(row.id, new Error(STUCK_RUN_MESSAGE), database);
    return { ...row, status: "error", error: STUCK_RUN_MESSAGE, completedAt: new Date() };
  }
  return row;
}

/** True if the most-recent run for `domain` is still `status='running'`. */
export async function isRunning(
  domain: TriageRunDomain,
  database: typeof defaultDb = defaultDb,
): Promise<boolean> {
  const latest = await latestRunFor(domain, { database });
  return latest?.status === "running";
}
