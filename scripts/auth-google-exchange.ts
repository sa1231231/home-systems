/**
 * One-shot OAuth code exchange. When the local-server flow (auth-google.ts)
 * isn't an option — e.g. you already clicked Allow and have a callback URL
 * with `?code=...` in your browser — paste the code here and this script
 * exchanges it for a refresh token without spinning up a server.
 *
 *   npm run auth:google:exchange -- '<code>'
 *
 * The code must be exchanged within ~10 minutes of the consent click and
 * is single-use. If it's expired/used you'll need a fresh consent flow.
 */
import "dotenv/config";
import { google } from "googleapis";

const REDIRECT_URI = "http://localhost:8765/oauth/callback";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const clientId = process.env.GOOGLE_CLIENT_ID ?? fail("GOOGLE_CLIENT_ID is required (set in .env)");
const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET ?? fail("GOOGLE_CLIENT_SECRET is required (set in .env)");

const codeArg = process.argv[2];
if (!codeArg) {
  console.error("usage: npm run auth:google:exchange -- '<code-from-callback-url>'");
  console.error("");
  console.error("The code is the value of `code=` in your browser URL after consent.");
  console.error('e.g. http://localhost:8765/oauth/callback?code=4/0AeoWuM-...&scope=...');
  console.error("        copy ^^^^^^^^^^^^^^^^^^^^^^^^^^ this part");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2({
  clientId,
  clientSecret,
  redirectUri: REDIRECT_URI,
});

try {
  const { tokens } = await oauth2Client.getToken(codeArg);
  if (!tokens.refresh_token) {
    console.error("\nNo refresh_token returned. Common causes:");
    console.error("  - This code was already exchanged (single-use).");
    console.error("  - The app was previously authorized without `prompt=consent`.");
    console.error(
      "    Revoke at https://myaccount.google.com/permissions and run `npm run auth:google` again.",
    );
    process.exit(1);
  }
  console.log("\n✓ refresh token received\n");
  console.log("Scopes granted:", tokens.scope);
  console.log("");
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Exchange failed: ${message}`);
  console.error("");
  console.error("Most likely the code is expired (~10 min) or already used.");
  console.error("Get a fresh one with `npm run auth:google`.");
  process.exit(1);
}
