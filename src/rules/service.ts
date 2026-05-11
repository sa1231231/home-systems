import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { rules } from "../db/schema.js";

export type RuleRow = typeof rules.$inferSelect;

export class RuleNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly id: number) {
    super(`rule ${id} not found`);
    this.name = "RuleNotFoundError";
  }
}

export async function getRule(
  id: number,
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const [row] = await database.select().from(rules).where(eq(rules.id, id));
  if (!row) throw new RuleNotFoundError(id);
  return row;
}

export async function setRuleEnabled(
  id: number,
  enabled: boolean,
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const [row] = await database
    .update(rules)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(rules.id, id))
    .returning();
  if (!row) throw new RuleNotFoundError(id);
  return row;
}

export async function toggleRuleEnabled(
  id: number,
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const current = await getRule(id, database);
  return setRuleEnabled(id, !current.enabled, database);
}

export async function deleteRule(
  id: number,
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const [row] = await database.delete(rules).where(eq(rules.id, id)).returning();
  if (!row) throw new RuleNotFoundError(id);
  return row;
}

export type RuleUpdate = {
  name?: string;
  notes?: string | null;
  priority?: number;
};

export async function updateRule(
  id: number,
  patch: RuleUpdate,
  database: typeof defaultDb = defaultDb,
): Promise<RuleRow> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.priority !== undefined) set.priority = patch.priority;
  const [row] = await database.update(rules).set(set).where(eq(rules.id, id)).returning();
  if (!row) throw new RuleNotFoundError(id);
  return row;
}
