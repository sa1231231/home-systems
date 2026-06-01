/**
 * Channel-agnostic outbound notification facade. Callers stay decoupled
 * from the underlying transport — they only see `sendNotification()`.
 *
 * Currently dispatches to Discord (webhook). Adding Pushover/Telegram/ntfy
 * later means adding a new env var to config.ts, a new module here, and a
 * new branch in `sendNotification()` — no caller needs to change.
 *
 * If no channel is configured, `sendNotification()` no-ops with
 * `delivered: false, channel: "none"`. The cron treats that as a failure
 * and records it in notification_log so the user can see why nothing fired.
 */

import { getConfig } from "../../config.js";
import { sendDiscordWebhook, type DiscordEmbedField } from "./discord.js";

export type NotificationField = DiscordEmbedField;

export type NotificationInput = {
  title: string;
  body: string;
  fields?: NotificationField[];
  url?: string;
  /** 0xRRGGBB integer for channels that support colored accents (Discord). */
  color?: number;
  /** Optional plain-text one-liner. Discord puts this in the top-level
   *  `content` field so the message stays readable even when embeds are
   *  hidden by channel/role permissions ("Embed Links" off). Plain-text
   *  channels (Pushover, ntfy) would use this directly as the body. */
  content?: string;
};

export type SendOutcome = {
  delivered: boolean;
  /** Which channel actually handled the send. "none" when no channel is configured. */
  channel: string;
  /** Populated on failure; undefined on success. */
  error?: string;
};

/** True if at least one channel is configured. Cron uses this to decide
 *  whether to bother computing triggers at all. */
export function hasNotificationChannel(): boolean {
  return Boolean(getConfig().DISCORD_WEBHOOK_URL);
}

export async function sendNotification(input: NotificationInput): Promise<SendOutcome> {
  const config = getConfig();
  if (config.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordWebhook(config.DISCORD_WEBHOOK_URL, {
        title: input.title,
        body: input.body,
        fields: input.fields,
        url: input.url,
        color: input.color,
        content: input.content,
      });
      return { delivered: true, channel: "discord" };
    } catch (err) {
      return {
        delivered: false,
        channel: "discord",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    delivered: false,
    channel: "none",
    error: "no notification channel configured (set DISCORD_WEBHOOK_URL)",
  };
}
