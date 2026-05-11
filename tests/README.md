# Test harness

The suite mixes three kinds of tests, all run by `vitest`:

1. **Pure-function unit tests** — colocated `*.test.ts` next to the source. No
   DB, no HTTP, no mocks. Fastest to run; preferred wherever the unit is pure.
2. **DB-backed unit tests** — colocated `*.test.ts` that use the pglite harness
   in `tests/helpers/test-db.ts`. Each file spins up a fresh in-process
   Postgres (WASM), runs all drizzle migrations against it, and resets state
   between tests.
3. **System tests** — `*.test.ts` colocated with the route file (`src/web/`,
   `src/api/`) that exercise express routers end-to-end via `supertest`. They
   mount only the router under test on a minimal `makeTestApp()` (no auth
   middleware unless the test opts in) and mock external integrations
   (`google.*`, `trello.*`, `anthropic`) per-file with `vi.mock`.

## Running

```bash
npm test                 # full suite
npm test -- path/foo     # one file or pattern
npm run typecheck        # tsc --noEmit
```

`vitest.config.ts` bumps `hookTimeout` to 30s so pglite + migrations have room
to start under parallel load.

## The `db` singleton

`src/db/client.ts` exports `db` and `pool` as **Proxy** instances. They lazy-
initialise a real `pg.Pool` against `DATABASE_URL` on first read. Tests call
`setTestDb(pgliteDrizzle, pool)` to swap the underlying reference *before*
any module reads `db`; the 22 importers see the test DB transparently.

```ts
import { createTestDb } from "../../tests/helpers/test-db.js";

let handle;
beforeAll(async () => { handle = await createTestDb(); });
afterAll(async () => { await handle.close(); });
beforeEach(async () => { await handle.reset(); });   // truncate all tables
```

`reset()` issues `TRUNCATE ... RESTART IDENTITY CASCADE` on every app-managed
table. `tests/cleanup-isolation.test.ts` is a belt-and-suspenders check that
inserting into every table in one test does not leak into the next.

## Clearing registries

The applier and reverser registries are process-wide singletons. Tests that
register fakes must clear them, or registrations leak between cases:

```ts
import { clearAppliers, setApplier } from "../../tests/helpers/registry.js";

beforeEach(() => {
  clearAppliers();             // empties the map
  setApplier("email", async () => {});
});
```

## Mocking external services

Per-file `vi.mock` against the integration module. Examples:

```ts
vi.mock("../sync/email-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/email-triage.js")>(
    "../sync/email-triage.js",
  );
  return { ...actual, triageEmails: vi.fn() };
});
```

This pattern preserves the module's other exports so dependent code keeps
working, and gives you a `vi.mocked(triageEmails)` handle to `.mockResolvedValueOnce()`
in each test.

Note: `vi.resetModules()` is **incompatible** with `vi.mock` — resetting the
module cache will re-import the *real* config (and read `.env`). If you need
per-test module isolation, restructure the test instead.

## Adding a new test

| Kind | Where | Pattern |
|---|---|---|
| Pure function | `src/path/foo.test.ts` | Plain `describe`/`it`. No DB. |
| DB-backed unit | `src/path/foo.test.ts` | `createTestDb()` + reset hooks. Mock external integrations. |
| HTTP route | `src/{web,api}/routes-foo.test.ts` | `makeTestApp()` + `request(app)` + `createTestDb()` + per-file external mocks. |

If you find yourself adding a new test that needs to mock `getConfig()`,
prefer `vi.mock("../../config.js", () => ({ getConfig: vi.fn() }))` and call
`.mockReturnValue(...)` in `beforeEach` — see `src/integrations/trello/auth.test.ts`.
