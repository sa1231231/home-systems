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

## Contacts sync (Phase 1b-β)

Two endpoints under `/contacts`:

- `GET /contacts/sync/plan` — dry-run. Returns what *would* change without writing anything. Always run this first.
- `POST /contacts/sync` — apply the plan. Writes to the Sheet.

Both accept `?verbose=true` to include the full per-field diff for refreshes (otherwise just the changed-column names).

**Match strategy** (in priority order):
1. `google_resource_name` column on the Sheet row matches the Google contact's resource name (the canonical key once a row is bound)
2. Email match (`dex_email` or any of `dex_emails`, lowercased trimmed)
3. Phone match (`dex_phone` or any of `dex_phones`, normalized to last 10 digits)

**One-time effect of the first sync:**
- A new column `google_resource_name` is appended to the Contacts tab if missing
- Sheet rows that match a Google contact via email/phone get that column populated (binding them for future syncs)
- Google contacts not present in the Sheet are appended as new rows with empty enrichment columns

**What gets refreshed each sync** (identity columns owned by Google):
`full_name`, `first_name`, `last_name`, `description`, `birthday`, `birthday_year`, `job_title`, `company`, `image_url`, `linkedin`, `website`, `dex_email`, `dex_emails`, `dex_phone`, `dex_phones`, `dex_address`, `updated_at`, `google_resource_name`

**What is never touched** (enrichment, owned by the Sheet):
`starred`, `is_archived`, `last_seen_at`, `location`, `dex_groups`, `dex_tags`, `created_at`, plus all legacy `*_last_interaction_*` / `*_message_link` / reminder columns.

**Soft rule:** an empty Google value never overwrites a non-empty Sheet value. Keeps manually-added Sheet data safe when Google has no value for the field. Trade-off: removing data in Google does *not* propagate to the Sheet — clear the Sheet cell manually if needed.

**Ambiguous matches** (one Google contact's email/phone matches multiple unbound Sheet rows) are surfaced in the plan but never applied — resolve manually by setting `google_resource_name` on the right row, then re-sync.

### One-time column cleanup

`npm run cleanup:columns` rewrites the Contacts tab to drop legacy Dex auto-tracking columns (`*_last_interaction_*`, `*_message_link`, reminder fields, unused social handles, Dex internal IDs) and rename identity columns from `dex_*` prefixes to clean names (`dex_email` → `email`, `linkedin` → `linkedin_url`, etc.). The canonical 25-column layout is defined in `src/sync/cleanup.ts`.

```bash
# Dry run (default — prints the plan, writes nothing)
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
GOOGLE_OAUTH_REFRESH_TOKEN=... CRM_SHEET_ID=... \
npm run cleanup:columns

# Apply
... npm run cleanup:columns -- --apply
```

After applying, verify with `curl /contacts/sync/plan` — the resulting sync plan should show `unchanged` ≈ all bound rows. Sheet revision history is rollback.

The sync code reads from BOTH old (`dex_email`, `dex_phone`, `linkedin`) and new (`email`, `phone`, `linkedin_url`) column names, so manual sync calls during the deploy/cleanup window remain safe.

### Duplicate detection / merge

`/contacts/dedupe/plan` and `/contacts/dedupe` find Sheet rows that share an email or phone (after normalization) and merge them into one canonical row.

- **Cluster definition**: union-find over rows; two rows are in the same cluster if they share any email OR phone (transitive — A–B via email, B–C via phone groups all three).
- **Canonical pick**: row with `google_resource_name` set wins; else the row with the most non-empty fields; tiebreak on lowest row index.
- **Merge rule**: for each column, if canonical's cell is empty AND any duplicate has a value, copy the first non-empty value into canonical. Never overwrites existing canonical data. `legacy_notes` are concatenated with `\n---\n` so all clusters' history is preserved.
- **Delete**: non-canonical rows removed via `spreadsheets.batchUpdate` with `deleteDimension`, sorted bottom-up so indices stay valid as the API processes serially.
- Rerun-safe — clusters that were already merged become no-ops; new clusters detected on subsequent runs.

### Nightly cron

home-systems runs an in-process `node-cron` scheduler. To enable nightly sync on Railway:

```
CONTACTS_SYNC_CRON_ENABLED=true
CONTACTS_SYNC_CRON_SCHEDULE=0 7 * * *      # optional; default is 7am UTC = 3am ET
```

The cron only runs when `CONTACTS_SYNC_CRON_ENABLED=true` (so dev environments stay quiet). Schedule strings are evaluated in **UTC**, regardless of Railway region. Failures log to stderr but never crash the server. If a sync collides with a redeploy, that night's run is skipped — next night will catch up.

To trigger a sync on demand at any time, just `curl -X POST` the `/contacts/sync` endpoint.

## Production notes

- Railway deploys build the Dockerfile (multi-stage, `node:20-alpine`).
- App startup runs `migrate()` before `listen()`. If migrations fail, the process exits non-zero and Railway will surface the error in deploy logs.
- `SIGTERM`/`SIGINT` trigger a graceful shutdown: HTTP server stops accepting new connections, then the pg pool closes.
- Postgres uses `ghcr.io/railwayapp-templates/postgres-ssl:18` — connections require TLS but the cert is self-signed within Railway's private network, so the pg client sets `ssl: { rejectUnauthorized: false }`.
