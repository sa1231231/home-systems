import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getConfig } from "../../config.js";

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
  cachedClient = new google.auth.OAuth2({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  cachedClient.setCredentials({ refresh_token: creds.refreshToken });
  return cachedClient;
}

export const SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.modify",
];
