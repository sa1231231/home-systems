import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";

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

function fakeClient() {
  return {
    listCards: vi.fn().mockResolvedValue([]) as never,
    moveCard: vi.fn().mockResolvedValue({}) as never,
    getBoard: vi.fn() as never,
    getLists: vi.fn() as never,
    getLabels: vi.fn() as never,
    getCard: vi.fn() as never,
    listMemberBoards: vi.fn() as never,
  };
}

const CREDS = {
  apiKey: "k",
  token: "t",
  boardId: "b",
  waitingListId: "lw",
  todayListId: "lt",
  tz: "UTC",
};

const DRY_RESULT = {
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
    it("renders a not-configured banner when creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp()).get("/ui/trello/");
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/isn't configured/i);
    });

    it("runs a dry-run reorder and renders the page when creds are configured", async () => {
      hasCredsMock.mockReturnValue(true);
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue(fakeClient() as never);
      runReorderMock.mockResolvedValueOnce(DRY_RESULT);
      const res = await request(buildApp()).get("/ui/trello/");
      expect(res.status).toBe(200);
      expect(runReorderMock).toHaveBeenCalledOnce();
      // dryRun should be true on the GET path
      expect(runReorderMock.mock.calls[0][2].dryRun).toBe(true);
    });
  });

  describe("POST /ui/trello/reorder", () => {
    it("returns 503 when creds are missing", async () => {
      hasCredsMock.mockReturnValue(false);
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.status).toBe(503);
      expect(runReorderMock).not.toHaveBeenCalled();
    });

    it("runs a non-dry reorder and renders a success flash", async () => {
      hasCredsMock.mockReturnValue(true);
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue(fakeClient() as never);
      runReorderMock.mockResolvedValueOnce({
        ...DRY_RESULT,
        planned: 3,
        moved: 1,
        reordered: 2,
        unchanged: 0,
      });
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.status).toBe(200);
      expect(runReorderMock.mock.calls[0][2].dryRun).toBe(false);
      expect(res.text).toMatch(/1 moved/);
      expect(res.text).toMatch(/2 reordered/);
    });

    it("renders an error flash when there are per-op errors", async () => {
      hasCredsMock.mockReturnValue(true);
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue(fakeClient() as never);
      runReorderMock.mockResolvedValueOnce({
        ...DRY_RESULT,
        planned: 1,
        moved: 0,
        reordered: 0,
        unchanged: 0,
        errors: [{ cardId: "c", error: "boom" }],
      });
      const res = await request(buildApp()).post("/ui/trello/reorder");
      expect(res.text).toMatch(/1 errors/);
    });
  });
});
