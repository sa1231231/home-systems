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

## Production notes

- Railway deploys build the Dockerfile (multi-stage, `node:20-alpine`).
- App startup runs `migrate()` before `listen()`. If migrations fail, the process exits non-zero and Railway will surface the error in deploy logs.
- `SIGTERM`/`SIGINT` trigger a graceful shutdown: HTTP server stops accepting new connections, then the pg pool closes.
- Postgres uses `ghcr.io/railwayapp-templates/postgres-ssl:18` — connections require TLS but the cert is self-signed within Railway's private network, so the pg client sets `ssl: { rejectUnauthorized: false }`.
