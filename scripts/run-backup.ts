import "dotenv/config";
import { getConfig } from "../src/config.js";
import { runBackupOnce } from "../src/crons/backup.js";
import { r2EndpointForAccount } from "../src/backup/pg_dump.js";

async function main() {
  const config = getConfig();
  const endpoint =
    config.R2_ENDPOINT ||
    (config.R2_ACCOUNT_ID ? r2EndpointForAccount(config.R2_ACCOUNT_ID) : undefined);
  if (!endpoint || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET) {
    console.error(
      "Need R2_ENDPOINT (or R2_ACCOUNT_ID) + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET",
    );
    process.exit(1);
  }
  await runBackupOnce({
    schedule: "manual",
    databaseUrl: config.DATABASE_URL,
    r2: {
      endpoint,
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      bucket: config.R2_BUCKET,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
