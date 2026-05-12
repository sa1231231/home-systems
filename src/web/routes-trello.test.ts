import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";

vi.mock("../integrations/trello/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/trello/auth.js")>(
    "../integrations/trello/auth.js",
  );
  return { ...actual, hasTrelloCreds: vi.fn(), requireTrelloCreds: vi.fn() };
});
vi.mock("../integrations/trello/client.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/trello/client.js")>(
    "../integrations/trello/client.js",
  );
  return { ...actual, makeTrelloClient: vi.fn() };
});
vi.mock("../sync/trello-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/trello-runner.js")>(
    "../sync/trello-runner.js",
  );
  return { ...actual, runTrelloReorderOnce: vi.fn() };
});

import { hasTrelloCreds, requireTrelloCreds } from "../integrations/trello/auth.js";
import { makeTrelloClient } from "../integrations/trello/client.js";
import { runTrelloReorderOnce } from "../sync/trello-runner.js";
import { makeTrelloUiRouter } from "./routes-trello.js";

const hasCredsMock = vi.mocked(hasTrelloCreds);
const requireCredsMock = vi.mocked(requireTrelloCreds);
const makeClientMock = vi.mocked(makeTrelloClient);
const runReorderMock = vi.mocked(runTrelloReorderOnce);

const CREDS = {
  apiKey: "k",
  token: "t",
  boardId: "b",
  waitingListId: "lw",
  todayListId: "lt",
  tz: "UTC",
};

const BASE_RESULT = {
  today: "2026-05-11",
  planned: 0,
  moved: 0,
  reordered: 0,
  unchanged: 0,
  errors: [],
  ops: [],
};

function buildApp() {
  const app = makeTestApp();
  mountViews(app);
  app.use("/ui/trello", makeTrelloUiRouter());
  return app;
}

describe("routes-trello", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    hasCredsMock.mockReset();
    requireCredsMock.mockReset();
    makeClientMock.mockReset();
    runReorderMock.mockReset();
  });

  describe("GET /ui/trello", () => {
    it("renders the not-configured banner when creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp()).get("/ui/trello/");
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/isn't configured/i);
      // GET should NOT hit Trello at all in the simplified flow.
      expect(runReorderMock).not.toHaveBeenCalled();
      expect(makeClientMock).not.toHaveBeenCalled();
    });

    it("renders just the activity table when configured (no Trello API calls)", async () => {
      hasCredsMock.mockReturnValue(true);
      const res = await request(buildApp()).get("/ui/trello/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("Recent activity");
      // No dry-run preview anymore — confirm we don't touch Trello on GET.
      expect(runReorderMock).not.toHaveBeenCalled();
      expect(makeClientMock).not.toHaveBeenCalled();
    });

    it("shows recent trello.* changelog rows", async () => {
      hasCredsMock.mockReturnValue(true);
      await db.insert(changelog).values({
        caller: "test",
        sessionId: "s",
        operation: "trello.move_card",
        targetKind: "trello_card",
        targetId: "marker-card-id",
        beforeState: {} as never,
        afterState: {} as never,
        status: "success",
      });
      const res = await request(buildApp()).get("/ui/trello/");
      expect(res.text).toContain("marker-card-id");
      expect(res.text).toContain("trello.move_card");
    });

    it("excludes non-trello changelog rows", async () => {
      hasCredsMock.mockReturnValue(true);
      await db.insert(changelog).values({
        caller: "test",
        sessionId: "s",
        operation: "email.modify_labels",
        targetKind: "email",
        targetId: "should-not-appear-in-trello",
        beforeState: {} as never,
        afterState: {} as never,
        status: "success",
      });
      const res = await request(buildApp()).get("/ui/trello/");
      expect(res.text).not.toContain("should-not-appear-in-trello");
    });
  });

  describe("POST /ui/trello/reorder", () => {
    it("returns 503 when creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.status).toBe(503);
      expect(runReorderMock).not.toHaveBeenCalled();
    });

    it("runs a non-dry reorder and returns HX-Refresh + success banner", async () => {
      hasCredsMock.mockReturnValue(true);
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue({} as never);
      runReorderMock.mockResolvedValueOnce({
        ...BASE_RESULT,
        planned: 3,
        moved: 1,
        reordered: 2,
      });
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.status).toBe(200);
      expect(res.headers["hx-refresh"]).toBe("true");
      expect(runReorderMock.mock.calls[0][2].dryRun).toBe(false);
      expect(res.text).toMatch(/flash ok/);
      expect(res.text).toMatch(/1 moved/);
      expect(res.text).toMatch(/2 reordered/);
    });

    it("renders an error banner when there are per-op errors", async () => {
      hasCredsMock.mockReturnValue(true);
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue({} as never);
      runReorderMock.mockResolvedValueOnce({
        ...BASE_RESULT,
        planned: 1,
        errors: [{ cardId: "c", error: "boom" }],
      });
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.text).toMatch(/flash err/);
      expect(res.text).toMatch(/1 errors/);
    });

    it("returns a 500 banner when runOnce throws", async () => {
      hasCredsMock.mockReturnValue(true);
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue({} as never);
      runReorderMock.mockRejectedValueOnce(new Error("trello 503"));
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/trello 503/);
    });
  });

  describe("GET /ui/trello/triage-status", () => {
    it("renders the running banner when a reorder is in-flight", async () => {
      hasCredsMock.mockReturnValue(true);
      const { triageRuns } = await import("../db/schema.js");
      await db.insert(triageRuns).values({
        domain: "trello",
        sessionId: "s",
        caller: "ui:trello.reorder",
        status: "running",
      });
      const res = await request(buildApp()).get("/ui/trello/triage-status");
      expect(res.text).toMatch(/Triage running/);
      expect(res.text).toContain("/ui/trello/triage-status?polling=1");
    });

    it("returns HX-Refresh when polling and the latest reorder just completed", async () => {
      hasCredsMock.mockReturnValue(true);
      const { triageRuns } = await import("../db/schema.js");
      await db.insert(triageRuns).values({
        domain: "trello",
        sessionId: "s",
        caller: "ui:trello.reorder",
        status: "success",
        completedAt: new Date(),
        summary: { moved: 1 } as never,
      });
      const res = await request(buildApp()).get("/ui/trello/triage-status?polling=1");
      expect(res.headers["hx-refresh"]).toBe("true");
    });
  });
});
