import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });
