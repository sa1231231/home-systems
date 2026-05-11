FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
# Note: scripts/ (e.g. auth-google.ts) is intentionally not copied — it's a
# local-only OAuth helper.

FROM node:20-alpine
RUN apk add --no-cache postgresql16-client
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY drizzle/ ./drizzle/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "dist/index.js"]
