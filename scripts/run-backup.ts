import "dotenv/config";
import { getConfig } from "../src/config.js";
import { runBackupOnce } from "../src/crons/backup.js";

async function main() {
  const config = getConfig();
  if (
    !config.R2_ACCOUNT_ID ||
    !config.R2_ACCESS_KEY_ID ||
    !config.R2_SECRET_ACCESS_KEY ||
    !config.R2_BUCKET
  ) {
    console.error("R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET are required");
    process.exit(1);
  }
  await runBackupOnce({
    enabled: true,
    schedule: "manual",
    databaseUrl: config.DATABASE_URL,
    r2: {
      accountId: config.R2_ACCOUNT_ID,
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
