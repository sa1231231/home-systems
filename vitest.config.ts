import { defineConfig } from "vitest/config";

// PGlite spins up a fresh WASM Postgres per test file and runs all drizzle
// migrations on it; the first call can be ~3-5s, and many files in parallel
// stack up. Bump the default hook timeout so beforeAll/afterAll have room.
export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
