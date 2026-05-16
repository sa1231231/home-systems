import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getConfig } from "../../config.js";
import { getProfileEmail } from "./gmail.js";

export type GoogleCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sheetId: string;
};

export class MissingGoogleCredsError extends Error {
  constructor() {
    super("google credentials not configured");
    this.name = "MissingGoogleCredsError";
  }
}

export function hasGoogleCreds(): boolean {
  const c = getConfig();
  return Boolean(
    c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.GOOGLE_OAUTH_REFRESH_TOKEN && c.CRM_SHEET_ID,
  );
}

export function requireGoogleCreds(): GoogleCreds {
  const c = getConfig();
  if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET || !c.GOOGLE_OAUTH_REFRESH_TOKEN || !c.CRM_SHEET_ID) {
    throw new MissingGoogleCredsError();
  }
  return {
    clientId: c.GOOGLE_CLIENT_ID,
    clientSecret: c.GOOGLE_CLIENT_SECRET,
    refreshToken: c.GOOGLE_OAUTH_REFRESH_TOKEN,
    sheetId: c.CRM_SHEET_ID,
  };
}

let cachedClient: OAuth2Client | undefined;

export function getOAuthClient(): OAuth2Client {
  if (cachedClient) return cachedClient;
  const creds = requireGoogleCreds();
  cachedClient = getOAuthClientFor(creds.refreshToken);
  return cachedClient;
}

/**
 * Build (and cache) an OAuth2Client for a specific refresh token. Used to
 * authenticate against each of the Gmail accounts being triaged. Clients are
 * cached by token so repeated calls within a process reuse the same instance.
 */
const clientByToken = new Map<string, OAuth2Client>();

export function getOAuthClientFor(refreshToken: string): OAuth2Client {
  const existing = clientByToken.get(refreshToken);
  if (existing) return existing;
  const c = getConfig();
  if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) {
    throw new MissingGoogleCredsError();
  }
  const client = new google.auth.OAuth2({
    clientId: c.GOOGLE_CLIENT_ID,
    clientSecret: c.GOOGLE_CLIENT_SECRET,
  });
  client.setCredentials({ refresh_token: refreshToken });
  clientByToken.set(refreshToken, client);
  return client;
}

/** The full set of refresh tokens to triage: the primary account plus GMAIL_ACCOUNTS. */
export function triageRefreshTokens(): string[] {
  const c = getConfig();
  const tokens: string[] = [];
  if (c.GOOGLE_OAUTH_REFRESH_TOKEN) tokens.push(c.GOOGLE_OAUTH_REFRESH_TOKEN);
  for (const t of c.GMAIL_ACCOUNTS) {
    if (!tokens.includes(t)) tokens.push(t);
  }
  return tokens;
}

let triageAccountsCache: Array<{ account: string; client: OAuth2Client }> | undefined;

/**
 * Resolve every triage Gmail account: one entry per refresh token, each with
 * its OAuth client and its account email address (from Gmail's profile API).
 * Cached for the process lifetime — env changes trigger a Railway redeploy.
 */
export async function getTriageAccounts(): Promise<Array<{ account: string; client: OAuth2Client }>> {
  if (triageAccountsCache) return triageAccountsCache;
  const out: Array<{ account: string; client: OAuth2Client }> = [];
  for (const token of triageRefreshTokens()) {
    const client = getOAuthClientFor(token);
    const account = await getProfileEmail(client);
    out.push({ account, client });
  }
  triageAccountsCache = out;
  return out;
}

/** Map an account email back to its OAuth client; falls back to the primary client. */
export async function resolveClientForAccount(account: string): Promise<OAuth2Client> {
  const accounts = await getTriageAccounts();
  const found = accounts.find((a) => a.account === account);
  return found ? found.client : getOAuthClient();
}

export const SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.modify",
];
