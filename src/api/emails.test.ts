import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { processedEmails } from "../db/schema.js";

vi.mock("../sync/email-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/email-triage.js")>(
    "../sync/email-triage.js",
  );
  return { ...actual, triageEmails: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return {
    ...actual,
    getOAuthClient: vi.fn(),
    requireGoogleCreds: vi.fn(),
    MissingGoogleCredsError: actual.MissingGoogleCredsError,
  };
});

import { triageEmails } from "../sync/email-triage.js";
import {
  getOAuthClient,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { makeEmailsRouter } from "./emails.js";

const triageMock = vi.mocked(triageEmails);
const oauthMock = vi.mocked(getOAuthClient);
const requireCredsMock = vi.mocked(requireGoogleCreds);

function buildApp() {
  const app = makeTestApp();
  app.use("/emails", makeEmailsRouter());
  return app;
}

describe("api/emails", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    triageMock.mockReset();
    oauthMock.mockReset();
    requireCredsMock.mockReset();
  });

  describe("POST /emails/triage", () => {
    it("rejects out-of-range limit", async () => {
      const res = await request(buildApp()).post("/emails/triage?limit=9999");
      expect(res.status).toBe(400);
    });

    it("returns 503 when google creds are missing", async () => {
      requireCredsMock.mockImplementation(() => {
        throw new MissingGoogleCredsError();
      });
      const res = await request(buildApp()).post("/emails/triage?limit=5");
      expect(res.status).toBe(503);
    });

    it("returns the triage summary on success", async () => {
      requireCredsMock.mockReturnValue({
        clientId: "x",
        clientSecret: "y",
        refreshToken: "z",
        sheetId: "s",
      });
      oauthMock.mockReturnValue({} as never);
      triageMock.mockResolvedValueOnce({
        total: 5,
        matched: 2,
        queued: 2,
        skipped: 1,
        errors: 0,
        items: [],
      });
      const res = await request(buildApp()).post("/emails/triage?limit=5&dry_run=true");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        dry_run: true,
        total: 5,
        matched: 2,
        queued: 2,
      });
      expect(triageMock.mock.calls[0][1].dryRun).toBe(true);
    });
  });

  describe("GET /emails/processed", () => {
    it("returns processed_emails rows newest-first", async () => {
      await db.insert(processedEmails).values({
        id: "m1",
        threadId: "t1",
        outcome: "matched_rule",
      });
      await db.insert(processedEmails).values({
        id: "m2",
        threadId: "t2",
        outcome: "needs_review",
      });
      const res = await request(buildApp()).get("/emails/processed");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
    });

    it("filters by outcome", async () => {
      await db.insert(processedEmails).values({
        id: "m-good",
        threadId: "t",
        outcome: "matched_rule",
      });
      await db.insert(processedEmails).values({
        id: "m-err",
        threadId: "t",
        outcome: "error",
        error: "oops",
      });
      const res = await request(buildApp()).get("/emails/processed?outcome=error");
      expect(res.body.count).toBe(1);
      expect(res.body.entries[0].id).toBe("m-err");
    });

    it("rejects an invalid outcome filter", async () => {
      const res = await request(buildApp()).get("/emails/processed?outcome=bogus");
      expect(res.status).toBe(400);
    });
  });
});
