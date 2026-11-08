# Pinned to the digests from the last known-good build. Pinning stops a new
# upstream base image from invalidating the runtime apt layer below (which fetches
# postgresql-client-18 from PGDG) and silently breaking deploys.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
# Note: scripts/ (e.g. auth-google.ts) is intentionally not copied — it's a
# local-only OAuth helper.

# Runtime image: Debian-based so we can install postgresql-client-18 from PGDG.
# Railway runs Postgres 18, and pg_dump must be >= the server major version,
# which Alpine doesn't currently package.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
# apt + curl retries so a transient hiccup fetching from apt.postgresql.org
# doesn't fail the whole image build (the recent deploy failures were this step).
RUN set -eux; \
    printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80-retries; \
    apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg lsb-release \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl --retry 5 --retry-delay 3 --retry-connrefused -fsSL \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y curl gnupg lsb-release \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY drizzle/ ./drizzle/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "dist/index.js"]
