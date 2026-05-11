import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { setTestDb } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

export type TestDb = PgliteDatabase<typeof schema>;

export type TestDbHandle = {
  db: TestDb;
  pglite: PGlite;
  /** Truncate every app-managed table. Use between tests for isolation. */
  reset(): Promise<void>;
  /** Close the underlying pglite + reset the app's singleton override. */
  close(): Promise<void>;
};

// Every table managed by the app. Order doesn't matter — we use CASCADE.
const ALL_TABLES = [
  "changelog",
  "ai_calls",
  "rules",
  "needs_review",
  "processed_emails",
  "processed_transactions",
  "daily_op_counters",
  "_meta",
];

/**
 * Spin up a fresh in-process Postgres (PGlite, WASM), apply drizzle migrations,
 * and install it as the app's `db`/`pool` singleton via `setTestDb()`.
 *
 * Call `.reset()` between tests to truncate state.
 * Call `.close()` in afterAll to shut down and restore the default singleton.
 */
export async function createTestDb(): Promise<TestDbHandle> {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await migrate(db, { migrationsFolder });

  // Adapter that satisfies the PoolLike contract used by setTestDb. PGlite has
  // its own close() lifecycle so the "pool.end" plumbing in app code is a no-op
  // here — the caller manages teardown via this handle.
  const pool = { async end() {} };
  setTestDb(db as never, pool);

  const reset = async (): Promise<void> => {
    const list = ALL_TABLES.map((t) => `"${t}"`).join(", ");
    await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  };

  const close = async (): Promise<void> => {
    setTestDb(null, null);
    await pglite.close();
  };

  return { db, pglite, reset, close };
}
