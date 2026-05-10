# Local Development

Setup mechanics for working on home-systems on your laptop. Design philosophy lives in the [README](../README.md); this is the operational notes.

## First-time setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and fill `DATABASE_URL`. For local dev, use the **public** Postgres URL from Railway:

1. Railway dashboard → `Postgres` service → **Variables** tab
2. Copy the value of `DATABASE_PUBLIC_URL` (looks like `postgresql://postgres:…@…proxy.rlwy.net:PORT/railway`)
3. Paste into `.env` as `DATABASE_URL=…`

The internal `*.railway.internal` URL only resolves inside Railway's network — the public URL is what your laptop can reach.

## Run the dev server

```bash
npm run dev
```

`tsx watch` reloads on file changes. Migrations apply automatically at startup, so a fresh DB will have the schema before the server starts listening. Then:

```bash
curl http://localhost:3000/         # service marker
curl http://localhost:3000/health   # uptime
curl http://localhost:3000/db-ping  # SELECT NOW() + count of _meta rows
```

## Test, typecheck, build

```bash
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
npm start          # node dist/index.js (production mode)
```

## Schema changes

The flow is **edit schema → generate SQL → commit → deploy**. Migrations apply on app startup; there is no manual `db:push` step in normal use.

```bash
# 1. Edit src/db/schema.ts

# 2. Generate the migration SQL (no DB connection needed)
npm run db:generate
# → produces drizzle/NNNN_<random>.sql + updates drizzle/meta/*.json

# 3. Commit both the schema change and the generated SQL
git add src/db/schema.ts drizzle/
git commit -m "..."

# 4. Push. Railway redeploys; migrations apply on startup.
git push
```

### When to use `db:push` instead

`npm run db:push` syncs schema directly to the DB without generating files. Use it for **throwaway exploration** against a scratch DB only. Never against production. The committed migrations in `drizzle/` are the source of truth for prod schema.

### Drizzle Studio (browse the DB)

```bash
npm run db:studio
```

Opens a web UI at the URL it prints — useful for inspecting rows/relationships without writing SQL.

## Google OAuth one-time setup

The `/contacts/google/preview` and `/contacts/sheet/preview` endpoints need a Google OAuth refresh token. Obtain it once locally with `npm run auth:google`, then paste it into Railway env vars.

**1. Create OAuth credentials in Google Cloud Console**

1. [Google Cloud Console](https://console.cloud.google.com/) → create a new project (or reuse one)
2. APIs & Services → Library → enable **People API** and **Google Sheets API**
3. APIs & Services → OAuth consent screen → **External** → fill the required fields → add `samasra93@gmail.com` (Sheet owner) as a test user
4. APIs & Services → Credentials → Create Credentials → OAuth Client ID → **Desktop app**
5. Copy the **Client ID** and **Client Secret**

**2. Run the helper**

```bash
GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' npm run auth:google
```

The script:
- Spins up a one-shot HTTP server on `http://localhost:8765`
- Opens your browser to Google's consent screen
- Sign in as `samasra93@gmail.com`
- You'll see "this app isn't verified" — click **Advanced → Go to [app] (unsafe)**. This is expected for unverified personal-use apps.
- Grant the requested scopes (read-only Contacts + Sheets read/write)
- The script captures the auth code, exchanges for tokens, prints the refresh token

**3. Set Railway env vars**

In Railway → home-systems service → Variables, add:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=1//...
CRM_SHEET_ID=12Eoq...FtuI    # the part of the sheet URL between /d/ and /edit
```

Railway auto-redeploys with the new vars.

**Caveat**: refresh tokens issued by an OAuth app in **Testing** status (the unverified-personal-use state) **expire after 7 days**. If `/contacts/*` starts returning auth errors, re-run `npm run auth:google` and update Railway. Putting the app in **Production** status (still unverified, no Google review needed) keeps refresh tokens indefinitely.

## Production notes

- Railway deploys build the Dockerfile (multi-stage, `node:20-alpine`).
- App startup runs `migrate()` before `listen()`. If migrations fail, the process exits non-zero and Railway will surface the error in deploy logs.
- `SIGTERM`/`SIGINT` trigger a graceful shutdown: HTTP server stops accepting new connections, then the pg pool closes.
- Postgres uses `ghcr.io/railwayapp-templates/postgres-ssl:18` — connections require TLS but the cert is self-signed within Railway's private network, so the pg client sets `ssl: { rejectUnauthorized: false }`.
