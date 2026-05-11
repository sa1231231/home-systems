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
import { makeEmailsRouter } from "./api/emails.js";
import { registerEmailReverser } from "./sync/email-actions.js";
import { registerEmailApplier } from "./sync/email-triage.js";
import { sessionIdMiddleware } from "./changelog/index.js";
import { getOAuthClient, hasGoogleCreds } from "./integrations/google/oauth.js";
import { registerContactReversers } from "./changelog/reversers/contacts.js";
import { startContactsSyncCron, stopContactsSyncCron } from "./crons/contacts-sync.js";
import { startEmailTriageCron, stopEmailTriageCron } from "./crons/email-triage.js";
import { startBackupCron, stopBackupCron } from "./crons/backup.js";
import {
  startTrelloReorderCron,
  stopTrelloReorderCron,
} from "./crons/trello-reorder.js";
import { hasTrelloCreds, requireTrelloAuth } from "./integrations/trello/auth.js";
import { makeTrelloClient } from "./integrations/trello/client.js";
import { registerTrelloReversers } from "./sync/trello-actions.js";
import { makeTrelloRouter } from "./api/trello.js";
import { requireAuth } from "./web/auth.js";
import { makeWebRouter } from "./web/index.js";

const config = getConfig();

if (config.UI_AUTH_ENABLED && (!config.UI_PASSWORD || !config.SESSION_SECRET)) {
  console.error(
    "UI_AUTH_ENABLED is on but UI_PASSWORD and/or SESSION_SECRET are not set " +
      "(min lengths 8 and 32). Set them, or explicitly set UI_AUTH_ENABLED=false " +
      "to leave the API/UI open.",
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../drizzle");
const viewsPath = path.resolve(__dirname, "web/views");
const publicPath = path.resolve(__dirname, "../public");

const app = express();

app.set("view engine", "ejs");
app.set("views", viewsPath);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(sessionIdMiddleware());
app.use("/static", express.static(publicPath, { maxAge: "1d", immutable: false }));

app.get("/", (_req, res) => {
  res.json({ service: "home-systems", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

const apiGate =
  config.UI_AUTH_ENABLED && config.SESSION_SECRET
    ? requireAuth({ secret: config.SESSION_SECRET, defaultMode: "json" })
    : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

app.use(
  "/ui",
  makeWebRouter({
    authEnabled: config.UI_AUTH_ENABLED,
    password: config.UI_PASSWORD ?? "",
    secret: config.SESSION_SECRET ?? "",
    secure: config.NODE_ENV === "production",
  }),
);

app.use("/contacts", apiGate, makeContactsRouter());
app.use("/changes", apiGate, makeChangesRouter());
app.use("/ai-calls", apiGate, makeAiCallsRouter());
app.use("/rules", apiGate, makeRulesRouter());
app.use("/needs-review", apiGate, makeNeedsReviewRouter());
app.use("/emails", apiGate, makeEmailsRouter());
app.use("/trello", apiGate, makeTrelloRouter());

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
    const oauth = getOAuthClient();
    registerContactReversers(oauth);
    registerEmailReverser(oauth);
    registerEmailApplier(oauth);
    console.log("contact + email reversers + email applier registered");
  }

  if (hasTrelloCreds()) {
    const trelloAuth = requireTrelloAuth();
    const trelloClient = makeTrelloClient(trelloAuth);
    registerTrelloReversers(trelloClient);
    console.log("trello reversers registered");
  }

  const server = app.listen(config.PORT, () => {
    console.log(`home-systems listening on :${config.PORT}`);
  });

  startContactsSyncCron({
    enabled: config.CONTACTS_SYNC_CRON_ENABLED,
    schedule: config.CONTACTS_SYNC_CRON_SCHEDULE,
  });

  startEmailTriageCron({
    enabled: config.EMAIL_TRIAGE_CRON_ENABLED,
    schedule: config.EMAIL_TRIAGE_CRON_SCHEDULE,
    limit: config.EMAIL_TRIAGE_CRON_LIMIT,
  });

  startTrelloReorderCron({
    enabled: config.TRELLO_REORDER_CRON_ENABLED,
    schedule: config.TRELLO_REORDER_CRON_SCHEDULE,
  });

  if (config.BACKUP_CRON_ENABLED) {
    if (
      !config.R2_ACCOUNT_ID ||
      !config.R2_ACCESS_KEY_ID ||
      !config.R2_SECRET_ACCESS_KEY ||
      !config.R2_BUCKET
    ) {
      console.error("[cron] r2 backup enabled but R2_* env vars are missing; not scheduling");
    } else {
      startBackupCron({
        enabled: true,
        schedule: config.BACKUP_CRON_SCHEDULE,
        databaseUrl: config.DATABASE_URL,
        r2: {
          accountId: config.R2_ACCOUNT_ID,
          accessKeyId: config.R2_ACCESS_KEY_ID,
          secretAccessKey: config.R2_SECRET_ACCESS_KEY,
          bucket: config.R2_BUCKET,
        },
      });
    }
  } else {
    console.log("[cron] r2 backup disabled (set BACKUP_CRON_ENABLED=true to enable)");
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, draining connections`);
    stopContactsSyncCron();
    stopEmailTriageCron();
    stopBackupCron();
    stopTrelloReorderCron();
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
