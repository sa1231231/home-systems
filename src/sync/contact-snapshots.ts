/**
 * Read/write the per-contact sync baseline (`contact_snapshots`). The
 * snapshot records the Google identity fields as of the last sync, keyed by
 * resource_name — the third leg of the 3-way compare that lets contacts sync
 * distinguish a Google change from a user's sheet edit.
 */
import { inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { contactSnapshots } from "../db/schema.js";

/** Last-synced Google identity values for one contact (IDENTITY_COLUMNS shape). */
export type SnapshotFields = Record<string, string>;

export type SnapshotEntry = { resourceName: string; fields: SnapshotFields };

/** Load snapshots for the given resource_names into a Map. */
export async function loadSnapshots(
  resourceNames: string[],
  database: typeof defaultDb = defaultDb,
): Promise<Map<string, SnapshotFields>> {
  const out = new Map<string, SnapshotFields>();
  const unique = [...new Set(resourceNames.filter(Boolean))];
  if (unique.length === 0) return out;
  // Chunk to stay well clear of Postgres' parameter ceiling.
  for (let i = 0; i < unique.length; i += 5000) {
    const chunk = unique.slice(i, i + 5000);
    const rows = await database
      .select()
      .from(contactSnapshots)
      .where(inArray(contactSnapshots.resourceName, chunk));
    for (const r of rows) out.set(r.resourceName, r.fields as SnapshotFields);
  }
  return out;
}

/** Drop snapshots for the given resource_names (contacts deleted in Google). */
export async function deleteSnapshots(
  resourceNames: string[],
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  const valid = [...new Set(resourceNames.filter(Boolean))];
  if (valid.length === 0) return;
  for (let i = 0; i < valid.length; i += 5000) {
    await database
      .delete(contactSnapshots)
      .where(inArray(contactSnapshots.resourceName, valid.slice(i, i + 5000)));
  }
}

/** Upsert snapshots — one batched statement. */
export async function writeSnapshots(
  entries: SnapshotEntry[],
  database: typeof defaultDb = defaultDb,
): Promise<void> {
  const valid = entries.filter((e) => e.resourceName);
  if (valid.length === 0) return;
  const now = new Date();
  for (let i = 0; i < valid.length; i += 1000) {
    const chunk = valid.slice(i, i + 1000);
    await database
      .insert(contactSnapshots)
      .values(chunk.map((e) => ({ resourceName: e.resourceName, fields: e.fields as never, syncedAt: now })))
      .onConflictDoUpdate({
        target: contactSnapshots.resourceName,
        set: {
          fields: sql`excluded.fields`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }
}
