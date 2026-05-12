/**
 * One-time OAuth helper. Run locally to obtain a refresh token for the
 * home-systems backend, then paste the printed token into Railway's env vars.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run auth:google
 *
 * Not bundled into the Docker image — see Dockerfile.
 */
import "dotenv/config";
import http from "http";
import { URL } from "url";
import open from "open";
import { google } from "googleapis";
import { SCOPES } from "../src/integrations/google/oauth.js";

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const clientId = process.env.GOOGLE_CLIENT_ID ?? fail("GOOGLE_CLIENT_ID is required");
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? fail("GOOGLE_CLIENT_SECRET is required");

const oauth2Client = new google.auth.OAuth2({
  clientId,
  clientSecret,
  redirectUri: REDIRECT_URI,
});

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/oauth/callback")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`OAuth error: ${error}. You can close this tab.`);
    server.close();
    fail(`OAuth error: ${error}`);
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing code parameter.");
    return;
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h2>Done.</h2><p>You can close this tab and return to the terminal.</p></body></html>");
    server.close();

    if (!tokens.refresh_token) {
      console.error("\nNo refresh_token returned. Common causes:");
      console.error("  - You've authorized this app before. Revoke at https://myaccount.google.com/permissions and retry.");
      console.error("  - prompt=consent may not have been respected (check the auth URL).");
      process.exit(1);
    }

    console.log("\n✓ refresh token received\n");
    console.log("Set these in Railway → home-systems service → Variables:\n");
    console.log(`  GOOGLE_CLIENT_ID=${clientId}`);
    console.log(`  GOOGLE_CLIENT_SECRET=${clientSecret}`);
    console.log(`  GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`  CRM_SHEET_ID=<your sheet id, e.g. 12Eoq...FtuI from the sheet URL>`);
    console.log("\nDone.");
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    server.close();
    fail(`token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(`Local OAuth helper listening on http://localhost:${PORT}`);
  console.log(`Opening browser to:\n  ${authUrl}\n`);
  open(authUrl).catch(() => {
    console.log("(could not auto-open browser — copy the URL above into your browser)");
  });
});

setTimeout(
  () => {
    console.error("Timed out waiting for OAuth callback after 5 minutes.");
    server.close();
    process.exit(1);
  },
  5 * 60 * 1000,
);
