import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

/**
 * Inbox emails that haven't yet been tagged with one of the three triage
 * labels. No time window: each run picks up where the last left off, so
 * the user can chew through a backlog by clicking multiple times.
 * Excludes Gmail's Promotions and Social tabs — Gmail already filters
 * those, no reason to spend AI calls re-classifying them. Updates is
 * intentionally kept (mixed content: Apps Script alerts, etc.).
 */
const TRIAGE_QUERY =
  "in:inbox -category:promotions -category:social " +
  '-label:"Noise" -label:"Worth Reading" -label:"Needs Reply"';

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

export type GmailLabel = { id: string; name: string };

export async function listLabels(client: OAuth2Client): Promise<GmailLabel[]> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = res.data.labels ?? [];
  return labels
    .filter((l): l is { id: string; name: string } => Boolean(l.id) && Boolean(l.name))
    .map((l) => ({ id: l.id, name: l.name }));
}

export async function createLabel(client: OAuth2Client, name: string): Promise<GmailLabel> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  const data = res.data;
  if (!data.id || !data.name) throw new Error(`labels.create returned no id/name for "${name}"`);
  return { id: data.id, name: data.name };
}

/**
 * Cache of label-name → label-id, keyed by OAuth2Client. Gmail labels rarely
 * change, so we list once per process and only refresh on a cache miss. The
 * WeakMap auto-evicts when a client is GC'd (tests use fresh clients).
 */
const labelMapCache = new WeakMap<OAuth2Client, Map<string, string>>();

async function getLabelMap(client: OAuth2Client): Promise<Map<string, string>> {
  let m = labelMapCache.get(client);
  if (m) return m;
  const labels = await listLabels(client);
  m = new Map(labels.map((l) => [l.name, l.id]));
  labelMapCache.set(client, m);
  return m;
}

/**
 * Resolve a Gmail label name (e.g. "noise") to its label-id.
 * Misses refresh the cache once; if still missing, create the label.
 * System labels (INBOX, STARRED, etc.) have id===name and resolve trivially.
 */
export async function resolveLabelId(client: OAuth2Client, name: string): Promise<string> {
  const map = await getLabelMap(client);
  let id = map.get(name);
  if (id) return id;
  // Refresh in case the label was created out-of-band since we cached.
  const labels = await listLabels(client);
  const fresh = new Map(labels.map((l) => [l.name, l.id]));
  labelMapCache.set(client, fresh);
  id = fresh.get(name);
  if (id) return id;
  const created = await createLabel(client, name);
  fresh.set(created.name, created.id);
  return created.id;
}

export async function resolveLabelIds(
  client: OAuth2Client,
  names: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    out.push(await resolveLabelId(client, name));
  }
  return out;
}

/** Test-only: clear the cached label map for a client. */
export function _resetLabelCache(client: OAuth2Client): void {
  labelMapCache.delete(client);
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
