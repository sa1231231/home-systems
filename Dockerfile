FROM node:20-alpine AS builder
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
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg lsb-release \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
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
