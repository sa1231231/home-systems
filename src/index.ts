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
import { registerTransactionApplier } from "./sync/transaction-triage.js";
import { registerContactReviewAppliers } from "./sync/contacts-applier.js";
import { sessionIdMiddleware } from "./changelog/index.js";
import { getOAuthClient, hasGoogleCreds, requireGoogleCreds } from "./integrations/google/oauth.js";
import { registerContactReversers } from "./changelog/reversers/contacts.js";
import { startContactsSyncCron, stopContactsSyncCron } from "./crons/contacts-sync.js";
import { startEmailTriageCron, stopEmailTriageCron } from "./crons/email-triage.js";
import {
  startTransactionTriageCron,
  stopTransactionTriageCron,
} from "./crons/transaction-triage.js";
import { startBackupCron, stopBackupCron } from "./crons/backup.js";
import { startGithubBackupCron, stopGithubBackupCron } from "./crons/github-backup.js";
import { r2EndpointForAccount } from "./backup/pg_dump.js";
import {
  startTrelloReorderCron,
  stopTrelloReorderCron,
} from "./crons/trello-reorder.js";
import { hasTrelloCreds, requireTrelloAuth } from "./integrations/trello/auth.js";
import { makeTrelloClient } from "./integrations/trello/client.js";
import { registerTrelloReversers } from "./sync/trello-actions.js";
import { makeTrelloRouter } from "./api/trello.js";
import { makeScraperRouter } from "./api/scraper.js";
import { makeAdminRouter } from "./api/admin.js";
import { requireAuth } from "./web/auth.js";
import { makeWebRouter } from "./web/index.js";
import type { BackupCronOptions } from "./crons/backup.js";
import type { GithubBackupCronOptions } from "./crons/github-backup.js";

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
    transactionsSheetId: config.TRANSACTIONS_SHEET_ID,
    transactionsTab: config.TRANSACTIONS_TAB,
    categoriesTab: config.CATEGORIES_TAB,
  }),
);

function resolveR2(): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
} | undefined {
  const endpoint =
    config.R2_ENDPOINT ||
    (config.R2_ACCOUNT_ID ? r2EndpointForAccount(config.R2_ACCOUNT_ID) : undefined);
  if (!endpoint || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET) {
    return undefined;
  }
  return {
    endpoint,
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    bucket: config.R2_BUCKET,
  };
}

const r2 = resolveR2();

const backupOptions: BackupCronOptions | undefined = r2
  ? {
      schedule: config.BACKUP_CRON_SCHEDULE,
      databaseUrl: config.DATABASE_URL,
      r2,
    }
  : undefined;

const githubBackupOptions: GithubBackupCronOptions | undefined =
  r2 && config.GITHUB_TOKEN && config.GITHUB_BACKUP_REPO
    ? {
        schedule: config.GITHUB_BACKUP_CRON_SCHEDULE,
        github: {
          repo: config.GITHUB_BACKUP_REPO,
          ref: config.GITHUB_BACKUP_REF,
          token: config.GITHUB_TOKEN,
        },
        r2,
      }
    : undefined;

app.use("/contacts", apiGate, makeContactsRouter());
app.use("/changes", apiGate, makeChangesRouter());
app.use("/ai-calls", apiGate, makeAiCallsRouter());
app.use("/rules", apiGate, makeRulesRouter());
app.use("/needs-review", apiGate, makeNeedsReviewRouter());
app.use("/emails", apiGate, makeEmailsRouter());
app.use("/trello", apiGate, makeTrelloRouter());
app.use("/scraper", apiGate, makeScraperRouter());
app.use(
  "/admin",
  apiGate,
  makeAdminRouter({ backup: backupOptions, githubBackup: githubBackupOptions }),
);

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
    const sheetCreds = requireGoogleCreds();
    registerContactReversers(oauth);
    registerEmailReverser();
    registerEmailApplier();
    registerContactReviewAppliers(oauth, { spreadsheetId: sheetCreds.sheetId });
    console.log("contact + email reversers + email/contact appliers registered");

    if (config.TRANSACTIONS_SHEET_ID) {
      registerTransactionApplier(oauth, {
        sheetId: config.TRANSACTIONS_SHEET_ID,
        transactionsTab: config.TRANSACTIONS_TAB,
        categoriesTab: config.CATEGORIES_TAB,
      });
      console.log("transaction applier registered");
    }
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
    timezone: config.CRON_TZ,
  });

  startEmailTriageCron({
    enabled: config.EMAIL_TRIAGE_CRON_ENABLED,
    schedule: config.EMAIL_TRIAGE_CRON_SCHEDULE,
    timezone: config.CRON_TZ,
  });

  startTransactionTriageCron({
    enabled: config.TRANSACTION_TRIAGE_CRON_ENABLED,
    schedule: config.TRANSACTION_TRIAGE_CRON_SCHEDULE,
    limit: config.TRANSACTION_TRIAGE_CRON_LIMIT,
    target: config.TRANSACTIONS_SHEET_ID
      ? {
          sheetId: config.TRANSACTIONS_SHEET_ID,
          transactionsTab: config.TRANSACTIONS_TAB,
          categoriesTab: config.CATEGORIES_TAB,
        }
      : undefined,
    timezone: config.CRON_TZ,
  });

  startTrelloReorderCron({
    enabled: config.TRELLO_REORDER_CRON_ENABLED,
    schedule: config.TRELLO_REORDER_CRON_SCHEDULE,
    timezone: config.CRON_TZ,
  });

  if (!backupOptions) {
    console.error(
      "[cron] r2 backup NOT scheduled: need R2_ENDPOINT (or R2_ACCOUNT_ID) + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET",
    );
  } else {
    startBackupCron(backupOptions);
  }

  if (!githubBackupOptions) {
    console.log(
      "[cron] github backup NOT scheduled: set GITHUB_TOKEN + GITHUB_BACKUP_REPO (and R2 vars) to enable",
    );
  } else {
    startGithubBackupCron(githubBackupOptions);
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, draining connections`);
    stopContactsSyncCron();
    stopEmailTriageCron();
    stopTransactionTriageCron();
    stopBackupCron();
    stopGithubBackupCron();
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
