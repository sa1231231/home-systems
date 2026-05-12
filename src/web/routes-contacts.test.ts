import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { changelog, needsReview, rules } from "../db/schema.js";

vi.mock("../sync/contacts.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/contacts.js")>(
    "../sync/contacts.js",
  );
  return { ...actual, runSync: vi.fn() };
});
vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return {
    ...actual,
    hasGoogleCreds: vi.fn(),
    getOAuthClient: vi.fn(),
    requireGoogleCreds: vi.fn(),
  };
});

import { runSync } from "../sync/contacts.js";
import {
  hasGoogleCreds,
  getOAuthClient,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { makeContactsUiRouter } from "./routes-contacts.js";

const syncMock = vi.mocked(runSync);
const hasCredsMock = vi.mocked(hasGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);
const requireCredsMock = vi.mocked(requireGoogleCreds);

function buildApp() {
  const app = makeTestApp();
  mountViews(app);
  app.use("/ui/contacts", makeContactsUiRouter());
  return app;
}

describe("routes-contacts", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    syncMock.mockReset();
    hasCredsMock.mockReset();
    oauthMock.mockReset();
    requireCredsMock.mockReset();
  });

  describe("GET /ui/contacts", () => {
    it("renders the page with empty state", async () => {
      const res = await request(buildApp()).get("/ui/contacts/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("Contacts sync");
    });

    it("renders recent contact-domain activity in the last 7 days", async () => {
      await db.insert(changelog).values({
        caller: "test",
        sessionId: "s",
        operation: "contacts.add_csv.groups",
        targetKind: "contact",
        targetId: "p/marker-contact",
        beforeState: {} as never,
        afterState: {} as never,
        status: "success",
      });
      const res = await request(buildApp()).get("/ui/contacts/");
      expect(res.text).toContain("p/marker-contact");
    });

    it("excludes contact-domain rows from non-contact targetKinds", async () => {
      await db.insert(changelog).values({
        caller: "test",
        sessionId: "s",
        operation: "email.modify_labels",
        targetKind: "email",
        targetId: "should-not-appear-in-contacts-tab",
        beforeState: {} as never,
        afterState: {} as never,
        status: "success",
      });
      const res = await request(buildApp()).get("/ui/contacts/");
      expect(res.text).not.toContain("should-not-appear-in-contacts-tab");
    });
  });

  describe("POST /ui/contacts/sync", () => {
    it("returns 503 when google creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp()).post("/ui/contacts/sync");
      expect(res.status).toBe(503);
      expect(syncMock).not.toHaveBeenCalled();
    });

    it("runs sync and renders a summary banner with HX-Refresh", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      requireCredsMock.mockReturnValue({
        clientId: "x",
        clientSecret: "y",
        refreshToken: "z",
        sheetId: "sheet-1",
      });
      syncMock.mockResolvedValueOnce({
        plan: {} as never,
        applied: true,
        summary: { inserted: 1, refreshed: 2, unchanged: 3, ambiguous: 4 },
      });
      const res = await request(buildApp()).post("/ui/contacts/sync");
      expect(res.status).toBe(200);
      expect(res.headers["hx-refresh"]).toBe("true");
      expect(res.text).toMatch(/inserted=1/);
      expect(res.text).toMatch(/refreshed=2/);
      expect(syncMock).toHaveBeenCalledOnce();
      expect(syncMock.mock.calls[0][1]).toBe("sheet-1");
    });

    it("returns 500 banner when runSync throws", async () => {
      hasCredsMock.mockReturnValue(true);
      oauthMock.mockReturnValue({} as never);
      requireCredsMock.mockReturnValue({
        clientId: "x",
        clientSecret: "y",
        refreshToken: "z",
        sheetId: "s",
      });
      syncMock.mockRejectedValueOnce(new Error("sheets 429"));
      const res = await request(buildApp()).post("/ui/contacts/sync");
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/sheets 429/);
    });
  });

  describe("GET /ui/contacts/triage-status", () => {
    it("renders the running banner when a run is in-flight for contact", async () => {
      const { triageRuns } = await import("../db/schema.js");
      await db.insert(triageRuns).values({
        domain: "contact",
        sessionId: "s",
        caller: "ui:contacts.sync",
        status: "running",
      });
      const res = await request(buildApp()).get("/ui/contacts/triage-status");
      expect(res.text).toMatch(/Triage running/);
      expect(res.text).toContain("/ui/contacts/triage-status?polling=1");
    });

    it("returns HX-Refresh when polling and the latest contact run just completed", async () => {
      const { triageRuns } = await import("../db/schema.js");
      await db.insert(triageRuns).values({
        domain: "contact",
        sessionId: "s",
        caller: "ui:contacts.sync",
        status: "success",
        completedAt: new Date(),
        summary: { inserted: 1 } as never,
      });
      const res = await request(buildApp()).get("/ui/contacts/triage-status?polling=1");
      expect(res.headers["hx-refresh"]).toBe("true");
    });
  });
});
