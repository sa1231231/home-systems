import { asc, eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { contactGroups } from "../db/schema.js";

export type ContactGroup = {
  id: number;
  name: string;
  sortOrder: number;
  archived: boolean;
};

/**
 * List non-archived group names in display order (sort_order asc, then name).
 * Used by the UI's no-group "assign group" dropdown — replaces the old
 * Lookup-tab read so renaming a sheet tab can't break the picker.
 */
export async function listGroups(
  database: typeof defaultDb = defaultDb,
): Promise<ContactGroup[]> {
  return database
    .select({
      id: contactGroups.id,
      name: contactGroups.name,
      sortOrder: contactGroups.sortOrder,
      archived: contactGroups.archived,
    })
    .from(contactGroups)
    .where(eq(contactGroups.archived, false))
    .orderBy(asc(contactGroups.sortOrder), asc(contactGroups.name));
}

/**
 * Upsert a group by name. Returns true if newly inserted, false if it already
 * existed. Used by both the seed script and any future "add group" UI.
 */
export async function upsertGroup(
  name: string,
  database: typeof defaultDb = defaultDb,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("group name cannot be empty");
  const existing = await database
    .select({ id: contactGroups.id })
    .from(contactGroups)
    .where(eq(contactGroups.name, trimmed))
    .limit(1);
  if (existing.length > 0) return false;
  await database.insert(contactGroups).values({ name: trimmed });
  return true;
}
