import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { registry as defaultRegistry, type ReverserRegistry } from "./reversers.js";
import type { ChangelogRow } from "./types.js";

export class EntryNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly id: number) {
    super(`changelog entry ${id} not found`);
    this.name = "EntryNotFoundError";
  }
}

export class NotReversibleError extends Error {
  readonly status = 409;
  constructor(readonly id: number, reason: string) {
    super(`changelog entry ${id} not reversible: ${reason}`);
    this.name = "NotReversibleError";
  }
}

export type ReverseResult = {
  id: number;
  reversed_by: number;
};

function toEntry(row: typeof changelog.$inferSelect): ChangelogRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    caller: row.caller,
    sessionId: row.sessionId,
    operation: row.operation,
    targetKind: row.targetKind,
    targetId: row.targetId,
    intent: row.intent,
    beforeState: row.beforeState as Record<string, unknown>,
    afterState: row.afterState as Record<string, unknown>,
    externalTarget: row.externalTarget,
    status: row.status as ChangelogRow["status"],
    error: row.error,
    undoneBy: row.undoneBy,
  };
}

export async function reverseOne(
  id: number,
  options: { database?: typeof defaultDb; registry?: ReverserRegistry } = {},
): Promise<ReverseResult> {
  const database = options.database ?? defaultDb;
  const registry = options.registry ?? defaultRegistry;
  const [row] = await database.select().from(changelog).where(eq(changelog.id, id));
  if (!row) throw new EntryNotFoundError(id);
  if (row.status !== "success") throw new NotReversibleError(id, `entry status is '${row.status}'`);
  if (row.undoneBy !== null) throw new NotReversibleError(id, `already undone by entry ${row.undoneBy}`);

  const entry = toEntry(row);
  const reversalSessionId = `undo:${row.sessionId}`;
  const [pending] = await database
    .insert(changelog)
    .values({
      caller: "api:changes.undo",
      sessionId: reversalSessionId,
      operation: `${row.operation}.undo`,
      targetKind: row.targetKind,
      targetId: row.targetId,
      intent: `undo of changelog ${row.id}`,
      beforeState: row.afterState as Record<string, unknown>,
      afterState: row.beforeState as Record<string, unknown>,
      externalTarget: row.externalTarget,
      status: "pending",
    })
    .returning({ id: changelog.id });

  try {
    await registry.reverse(entry);
    await database.update(changelog).set({ status: "success" }).where(eq(changelog.id, pending.id));
    await database.update(changelog).set({ undoneBy: pending.id }).where(eq(changelog.id, row.id));
    return { id: row.id, reversed_by: pending.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await database
      .update(changelog)
      .set({ status: "failed", error: message.slice(0, 4000) })
      .where(eq(changelog.id, pending.id));
    throw err;
  }
}
