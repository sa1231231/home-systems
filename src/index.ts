import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getConfig } from "./config.js";
import { db, pool } from "./db/client.js";
import { meta } from "./db/schema.js";
import { makeContactsRouter } from "./api/contacts.js";
import { makeChangesRouter } from "./api/changes.js";
import { makeAiCallsRouter } from "./api/ai-calls.js";
import { makeRulesRouter } from "./api/rules.js";
import { makeNeedsReviewRouter } from "./api/needs-review.js";
import { sessionIdMiddleware } from "./changelog/index.js";
import { getOAuthClient, hasGoogleCreds } from "./integrations/google/oauth.js";
import { registerContactReversers } from "./changelog/reversers/contacts.js";
import { startContactsSyncCron, stopContactsSyncCron } from "./crons/contacts-sync.js";

const config = getConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../drizzle");

const app = express();

app.use(express.json());
app.use(sessionIdMiddleware());

app.get("/", (_req, res) => {
  res.json({ service: "home-systems", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

app.use("/contacts", makeContactsRouter());
app.use("/changes", makeChangesRouter());
app.use("/ai-calls", makeAiCallsRouter());
app.use("/rules", makeRulesRouter());
app.use("/needs-review", makeNeedsReviewRouter());

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

async function start() {
  console.log(`home-systems starting (${config.NODE_ENV})`);
  console.log(`applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log("migrations applied");

  if (hasGoogleCreds()) {
    registerContactReversers(getOAuthClient());
    console.log("contact reversers registered");
  }

  const server = app.listen(config.PORT, () => {
    console.log(`home-systems listening on :${config.PORT}`);
  });

  startContactsSyncCron({
    enabled: config.CONTACTS_SYNC_CRON_ENABLED,
    schedule: config.CONTACTS_SYNC_CRON_SCHEDULE,
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, draining connections`);
    stopContactsSyncCron();
    server.close(() => {
      console.log("http server closed");
    });
    await pool.end();
    console.log("pg pool closed");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});
