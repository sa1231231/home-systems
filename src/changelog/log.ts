import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import type { LogEntryInput } from "./types.js";

export async function logPending(entry: LogEntryInput): Promise<number> {
  const [row] = await db
    .insert(changelog)
    .values({
      caller: entry.caller,
      sessionId: entry.sessionId,
      operation: entry.operation,
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      intent: entry.intent ?? null,
      beforeState: entry.before,
      afterState: entry.after,
      externalTarget: entry.externalTarget ?? null,
      status: "pending",
    })
    .returning({ id: changelog.id });
  return row.id;
}

export async function markSuccess(id: number): Promise<void> {
  await db.update(changelog).set({ status: "success" }).where(eq(changelog.id, id));
}

export async function markFailed(id: number, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(changelog)
    .set({ status: "failed", error: message.slice(0, 4000) })
    .where(eq(changelog.id, id));
}

export async function withChangelog<T>(entry: LogEntryInput, fn: () => Promise<T>): Promise<T> {
  const id = await logPending(entry);
  try {
    const result = await fn();
    await markSuccess(id);
    return result;
  } catch (err) {
    await markFailed(id, err);
    throw err;
  }
}
