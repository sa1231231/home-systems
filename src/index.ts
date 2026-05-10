import express from "express";
import { sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { meta } from "./db/schema.js";

const app = express();

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "home-systems", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

app.get("/db-ping", async (_req, res) => {
  try {
    const result = await db.execute<{ now: Date }>(sql`SELECT NOW() AS now`);
    const metaRows = await db.select().from(meta);
    res.json({ ok: true, db_now: result.rows[0]?.now, meta_rows: metaRows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

app.listen(config.PORT, () => {
  console.log(`home-systems listening on :${config.PORT} (${config.NODE_ENV})`);
});
