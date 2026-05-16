import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";

vi.mock("../sync/email-triage.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/email-triage.js")>(
    "../sync/email-triage.js",
  );
  return { ...actual, triageAllAccounts: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return { ...actual, hasGoogleCreds: vi.fn() };
});

import { triageAllAccounts } from "../sync/email-triage.js";
import { hasGoogleCreds } from "../integrations/google/oauth.js";
import { groupByAccount, makeGmailUiRouter } from "./routes-gmail.js";

const triageMock = vi.mocked(triageAllAccounts);
const hasCredsMock = vi.mocked(hasGoogleCreds);

function buildApp() {
  const app = makeTestApp();
  mountViews(app);
  app.use("/ui/gmail", makeGmailUiRouter());
  return app;
}

describe("routes-gmail", () => {
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
    hasCredsMock.mockReset();
  });

  describe("GET /ui/gmail", () => {
    it("renders an empty rules + pending state", async () => {
      const res = await request(buildApp()).get("/ui/gmail/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/html/);
      expect(res.text).toContain("Gmail triage");
    });

    it("includes a domain=email rule row", async () => {
      await db.insert(rules).values({
        domain: "email",
        name: "marker-rule",
        match: { op: "present", field: "from" } as never,
        action: { category: "noise", reasoning: "x" } as never,
        priority: 100,
        enabled: true,
        createdBy: "test",
      });
      const res = await request(buildApp()).get("/ui/gmail/");
      expect(res.text).toContain("marker-rule");
    });

    it("excludes rules from other domains", async () => {
      await db.insert(rules).values({
        domain: "transaction",
        name: "tx-rule",
        match: { op: "present", field: "transaction_id" } as never,
        action: { category: "X" } as never,
        createdBy: "test",
      });
      const res = await request(buildApp()).get("/ui/gmail/");
      expect(res.text).not.toContain("tx-rule");
    });

    it("includes pending email reviews", async () => {
      await db.insert(needsReview).values({
        domain: "email",
        subject: { from: "alice@example.com", subject: "marker-subject" } as never,
        subjectKind: "email",
        subjectId: "m1",
        proposedAction: { category: "noise", reasoning: "spam" } as never,
        status: "pending",
      });
      const res = await request(buildApp()).get("/ui/gmail/");
      expect(res.text).toContain("marker-subject");
      expect(res.text).toContain("alice@example.com");
    });
  });

  describe("POST /ui/gmail/triage", () => {
    it("returns 503 when google creds aren't configured", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp()).post("/ui/gmail/triage");
      expect(res.status).toBe(503);
      expect(res.text).toMatch(/credentials/i);
      expect(triageMock).not.toHaveBeenCalled();
    });

    it("runs triage and sets HX-Refresh + summary banner on success", async () => {
      hasCredsMock.mockReturnValue(true);
      triageMock.mockResolvedValueOnce({
        total: 5,
        matched: 2,
        queued: 1,
        skipped: 2,
        errors: 0,
        items: [],
        accounts: [
          { account: "me@gmail.com", total: 5, matched: 2, queued: 1, skipped: 2, errors: 0 },
        ],
      });
      const res = await request(buildApp()).post("/ui/gmail/triage");
      expect(res.status).toBe(200);
      expect(res.headers["hx-refresh"]).toBe("true");
      expect(res.text).toMatch(/matched=2/);
      expect(res.text).toMatch(/queued=1/);

      expect(triageMock).toHaveBeenCalledOnce();
      const opts = triageMock.mock.calls[0][0];
      expect(opts.caller).toBe("ui:gmail.triage");
    });

    it("returns a 500 banner when triageAllAccounts throws", async () => {
      hasCredsMock.mockReturnValue(true);
      triageMock.mockRejectedValueOnce(new Error("gmail 500"));
      const res = await request(buildApp()).post("/ui/gmail/triage");
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/gmail 500/);
      expect(res.headers["hx-refresh"]).toBeUndefined();
    });

    it("escapes < in the error banner to prevent HTML injection", async () => {
      hasCredsMock.mockReturnValue(true);
      triageMock.mockRejectedValueOnce(new Error("<script>alert(1)</script>"));
      const res = await request(buildApp()).post("/ui/gmail/triage");
      expect(res.status).toBe(500);
      expect(res.text).not.toContain("<script>alert");
      expect(res.text).toContain("&lt;script");
    });

    it("returns 503 with an actionable banner when ANTHROPIC_API_KEY is missing", async () => {
      hasCredsMock.mockReturnValue(true);
      const { MissingAnthropicKeyError } = await import("../ai/index.js");
      triageMock.mockRejectedValueOnce(new MissingAnthropicKeyError());
      const res = await request(buildApp()).post("/ui/gmail/triage");
      expect(res.status).toBe(503);
      expect(res.text).toMatch(/ANTHROPIC_API_KEY/);
    });
  });

  describe("GET /ui/gmail/triage-status", () => {
    it("renders the running banner when a run is in-flight for email", async () => {
      const { triageRuns } = await import("../db/schema.js");
      await db.insert(triageRuns).values({
        domain: "email",
        sessionId: "s",
        caller: "ui:gmail.triage",
        status: "running",
      });
      const res = await request(buildApp()).get("/ui/gmail/triage-status");
      expect(res.text).toMatch(/Triage running/);
      expect(res.text).toContain("/ui/gmail/triage-status?polling=1");
    });

    it("returns HX-Refresh when polling and the latest run just completed", async () => {
      const { triageRuns } = await import("../db/schema.js");
      await db.insert(triageRuns).values({
        domain: "email",
        sessionId: "s",
        caller: "ui:gmail.triage",
        status: "success",
        completedAt: new Date(),
        summary: { total: 1 } as never,
      });
      const res = await request(buildApp()).get("/ui/gmail/triage-status?polling=1");
      expect(res.headers["hx-refresh"]).toBe("true");
    });
  });

  describe("groupByAccount", () => {
    const rule = (match: unknown) => ({ match }) as never;
    const review = (account?: string) =>
      ({ subject: account ? { account } : {} }) as never;

    it("buckets rules and reviews by the account in their match/subject", () => {
      const groups = groupByAccount(
        [rule({ all: [{ field: "account", op: "equals", value: "b@gmail.com" }] }), rule({ all: [{ field: "account", op: "equals", value: "a@gmail.com" }] })],
        [review("a@gmail.com"), review("a@gmail.com"), review("b@gmail.com")],
      );
      expect(groups.map((g) => g.account)).toEqual(["a@gmail.com", "b@gmail.com"]);
      expect(groups[0].rules).toHaveLength(1);
      expect(groups[0].pending).toHaveLength(2);
      expect(groups[1].rules).toHaveLength(1);
      expect(groups[1].pending).toHaveLength(1);
    });

    it("buckets account-less rules/reviews under (unscoped), sorted last", () => {
      const groups = groupByAccount(
        [rule({ op: "equals", field: "from", value: "x@y.com" })],
        [review("a@gmail.com"), review()],
      );
      expect(groups.map((g) => g.account)).toEqual(["a@gmail.com", "(unscoped)"]);
    });

    it("returns a single placeholder group when there is nothing", () => {
      const groups = groupByAccount([], []);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ rules: [], pending: [] });
    });
  });
});
