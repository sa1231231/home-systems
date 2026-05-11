import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getConfig } from "../config.js";
import * as schema from "./schema.js";

type DrizzleDb = ReturnType<typeof drizzle>;

interface PoolLike {
  end(): Promise<void>;
}

let _db: DrizzleDb | null = null;
let _pool: PoolLike | null = null;

function initDefault(): void {
  if (_db && _pool) return;
  const config = getConfig();
  const realPool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  _pool = realPool;
  _db = drizzle(realPool, { schema });
}

/**
 * Replace the singleton db + pool. Intended for test harnesses only.
 * Pass `null` to reset and allow the default Postgres pool to be initialised
 * again on next access.
 */
export function setTestDb(testDb: DrizzleDb | null, testPool: PoolLike | null = null): void {
  _db = testDb;
  _pool = testPool;
}

// Lazy proxies so the default pg.Pool isn't instantiated until first use.
// This lets test setup call setTestDb() before any DB access happens.
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    initDefault();
    return Reflect.get(_db as object, prop, receiver);
  },
}) as DrizzleDb;

export const pool: PoolLike = new Proxy({} as PoolLike, {
  get(_target, prop, receiver) {
    initDefault();
    return Reflect.get(_pool as object, prop, receiver);
  },
}) as PoolLike;
