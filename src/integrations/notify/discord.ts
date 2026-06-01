/**
 * Minimal Discord webhook sender. One HTTP POST, no SDK — webhook payloads
 * are documented at https://discord.com/developers/docs/resources/webhook#execute-webhook.
 *
 * We render every notification as a single embed (title + description, with
 * optional fields and a color stripe). Embeds look identical on desktop and
 * mobile and survive Discord's mobile-push preview better than plain content.
 */

export type DiscordEmbedField = { name: string; value: string; inline?: boolean };

export type DiscordWebhookPayload = {
  title: string;
  body: string;
  fields?: DiscordEmbedField[];
  /** Clickable URL on the embed title (e.g. link to the contact in the sheet). */
  url?: string;
  /** 0xRRGGBB integer. Gold = 0xFFD700, red = 0xFF4444. */
  color?: number;
  /** Plain-text one-liner sent as Discord's top-level `content` field. This
   *  renders even when the channel/role lacks the "Embed Links" permission
   *  (otherwise embeds appear blank). Falls back to `title` if omitted. */
  content?: string;
};

/** Username shown on the message. Keep it short — appears next to every message. */
const WEBHOOK_USERNAME = "home-systems";

export async function sendDiscordWebhook(
  webhookUrl: string,
  payload: DiscordWebhookPayload,
): Promise<void> {
  const body = {
    username: WEBHOOK_USERNAME,
    // Always include a plain-text content line. Embeds can be silently
    // hidden by Discord (e.g. when the channel role lacks "Embed Links");
    // the content line is what guarantees the message is actually read.
    content: payload.content ?? payload.title,
    embeds: [
      {
        title: payload.title,
        description: payload.body,
        url: payload.url,
        color: payload.color,
        fields: payload.fields,
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Discord webhook returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
    );
  }
}
