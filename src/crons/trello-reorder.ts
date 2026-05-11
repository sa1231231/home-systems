import cron from "node-cron";
import { newSessionId } from "../changelog/index.js";
import { MissingTrelloCredsError, requireTrelloCreds } from "../integrations/trello/auth.js";
import { makeTrelloClient } from "../integrations/trello/client.js";
import { runTrelloReorderOnce } from "../sync/trello-runner.js";

export type TrelloReorderCronOptions = {
  enabled: boolean;
  schedule: string;
};

let scheduledTask: cron.ScheduledTask | undefined;

export function startTrelloReorderCron(opts: TrelloReorderCronOptions): void {
  if (!opts.enabled) {
    console.log("[cron] trello reorder disabled (set TRELLO_REORDER_CRON_ENABLED=true to enable)");
    return;
  }
  if (!cron.validate(opts.schedule)) {
    console.error(`[cron] invalid TRELLO_REORDER_CRON_SCHEDULE: ${opts.schedule}`);
    return;
  }
  console.log(`[cron] trello reorder scheduled: "${opts.schedule}" (UTC)`);
  scheduledTask = cron.schedule(opts.schedule, runTrelloReorderOnceFromCron, { timezone: "UTC" });
}

export function stopTrelloReorderCron(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = undefined;
  }
}

export async function runTrelloReorderOnceFromCron(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[cron] trello reorder starting at ${startedAt}`);
  try {
    const creds = requireTrelloCreds();
    const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
    const result = await runTrelloReorderOnce(client, creds, {
      dryRun: false,
      sessionId: newSessionId(),
      caller: "cron:trello.reorder",
    });
    console.log(
      `[cron] trello reorder done: today=${result.today} moved=${result.moved} reordered=${result.reordered} unchanged=${result.unchanged} errors=${result.errors.length}`,
    );
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        console.error(`[cron] trello reorder error: card=${e.cardId} error=${e.error}`);
      }
    }
  } catch (err) {
    if (err instanceof MissingTrelloCredsError) {
      console.error("[cron] trello reorder skipped: credentials not configured");
      return;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[cron] trello reorder FAILED: ${message}`);
  }
}
