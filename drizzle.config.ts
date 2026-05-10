import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Note: DATABASE_URL is only consulted by `drizzle-kit push` / `studio`. Migrations
// are applied at app startup via drizzle-orm's migrator (see src/index.ts), so the
// normal flow doesn't require a local DATABASE_URL — only `generate` does, and that
// runs purely on schema files. The placeholder keeps `generate` working without env.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://placeholder@localhost/placeholder",
    ssl: { rejectUnauthorized: false },
  },
});
