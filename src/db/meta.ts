/**
 * Tiny key/value accessor over the `_meta` table. Used for small bits of
 * cross-run state — e.g. the Google People API sync token.
 */
import { eq } from "drizzle-orm";
import { db as defaultDb } from "./client.js";
import { meta } from "./schema.js";

export async function getMeta(
  key: string,
  database: typeof defaultDb = defaultDb,
): Promise<string | null> {
  const [row] = await database.select().from(meta).where(eq(meta.key, key)).limit(1);
  return row?.value ?? null;
}

export async function setMeta(
  key: string,
  value: string,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  await database
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } });
}

export async function deleteMeta(
  key: string,
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  await database.delete(meta).where(eq(meta.key, key));
}
