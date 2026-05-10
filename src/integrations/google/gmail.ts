import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const TRIAGE_QUERY =
  "in:inbox newer_than:1d -category:promotions -category:social -category:updates";

export type GmailMessageRef = { id: string; threadId: string };

export type GmailMetadata = {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string;
  labelIds: string[];
  receivedAt: Date | null;
};

export async function listTriageInbox(
  client: OAuth2Client,
  options: { limit: number },
): Promise<GmailMessageRef[]> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: TRIAGE_QUERY,
    maxResults: options.limit,
  });
  const messages = res.data.messages ?? [];
  return messages
    .filter((m): m is { id: string; threadId: string } => Boolean(m.id) && Boolean(m.threadId))
    .map((m) => ({ id: m.id, threadId: m.threadId }));
}

export async function getMessageMetadata(
  client: OAuth2Client,
  id: string,
): Promise<GmailMetadata> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: ["From", "To", "Subject"],
  });
  return parseMessage(res.data as RawGmailMessage);
}

export async function modifyLabels(
  client: OAuth2Client,
  id: string,
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<string[]> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.messages.modify({
    userId: "me",
    id,
    requestBody: {
      addLabelIds: changes.addLabelIds ?? [],
      removeLabelIds: changes.removeLabelIds ?? [],
    },
  });
  return res.data.labelIds ?? [];
}

// --- pure parsing (testable without an http client) ----------------------

export type RawGmailMessage = {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  labelIds?: string[] | null;
  internalDate?: string | null;
  payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
};

export function parseMessage(raw: RawGmailMessage): GmailMetadata {
  const id = raw.id ?? "";
  const threadId = raw.threadId ?? "";
  const headers = raw.payload?.headers ?? [];
  const header = (name: string): string | null => {
    const h = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
    return h?.value ?? null;
  };
  let receivedAt: Date | null = null;
  if (raw.internalDate) {
    const ms = Number(raw.internalDate);
    if (Number.isFinite(ms)) receivedAt = new Date(ms);
  }
  return {
    id,
    threadId,
    from: header("From"),
    to: header("To"),
    subject: header("Subject"),
    snippet: raw.snippet ?? "",
    labelIds: raw.labelIds ?? [],
    receivedAt,
  };
}
