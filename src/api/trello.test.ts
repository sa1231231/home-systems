import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";

vi.mock("../integrations/trello/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/trello/auth.js")>(
    "../integrations/trello/auth.js",
  );
  return {
    ...actual,
    requireTrelloAuth: vi.fn(),
    requireTrelloCreds: vi.fn(),
  };
});
vi.mock("../integrations/trello/client.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/trello/client.js")>(
    "../integrations/trello/client.js",
  );
  return { ...actual, makeTrelloClient: vi.fn(), trelloGetRaw: vi.fn() };
});
vi.mock("../sync/trello-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/trello-runner.js")>(
    "../sync/trello-runner.js",
  );
  return { ...actual, runTrelloReorderOnce: vi.fn() };
});

import {
  MissingTrelloCredsError,
  requireTrelloAuth,
  requireTrelloCreds,
} from "../integrations/trello/auth.js";
import { makeTrelloClient, trelloGetRaw } from "../integrations/trello/client.js";
import { runTrelloReorderOnce } from "../sync/trello-runner.js";
import { makeTrelloRouter } from "./trello.js";

const requireAuthMock = vi.mocked(requireTrelloAuth);
const requireCredsMock = vi.mocked(requireTrelloCreds);
const makeClientMock = vi.mocked(makeTrelloClient);
const rawMock = vi.mocked(trelloGetRaw);
const runReorderMock = vi.mocked(runTrelloReorderOnce);

const CREDS = {
  apiKey: "k",
  token: "t",
  boardId: "b",
  waitingListId: "lw",
  todayListId: "lt",
  tz: "UTC",
};

function fakeClient() {
  return {
    listCards: vi.fn().mockResolvedValue([]) as never,
    moveCard: vi.fn().mockResolvedValue({}) as never,
    listMemberBoards: vi.fn().mockResolvedValue([{ id: "b1", name: "Board", closed: false }]) as never,
    getBoard: vi.fn() as never,
    getLists: vi.fn().mockResolvedValue([{ id: "l1", name: "List", closed: false, idBoard: "b1", pos: 0 }]) as never,
    getLabels: vi.fn().mockResolvedValue([{ id: "lab1", name: "label", color: "blue" }]) as never,
    getCard: vi.fn() as never,
  };
}

function buildApp() {
  const app = makeTestApp();
  app.use("/trello", makeTrelloRouter());
  return app;
}

describe("api/trello", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    requireAuthMock.mockReset();
    requireCredsMock.mockReset();
    makeClientMock.mockReset();
    rawMock.mockReset();
    runReorderMock.mockReset();
  });

  describe("GET /trello/discover", () => {
    it("returns 503 when only key+token are missing", async () => {
      requireAuthMock.mockImplementation(() => {
        throw new MissingTrelloCredsError(["TRELLO_API_KEY", "TRELLO_TOKEN"]);
      });
      const res = await request(buildApp()).get("/trello/discover");
      expect(res.status).toBe(503);
    });

    it("returns boards + lists + labels + custom fields when configured", async () => {
      requireAuthMock.mockReturnValue({ apiKey: "k", token: "t" });
      makeClientMock.mockReturnValue(fakeClient() as never);
      rawMock.mockImplementation(async (_a, path) => {
        if (path.includes("/organizations")) return [{ id: "o1", displayName: "My Org", name: "myorg" }];
        if (path.includes("/customFields")) return [];
        return [];
      });
      const res = await request(buildApp()).get("/trello/discover");
      expect(res.status).toBe(200);
      expect(res.body.organizations).toHaveLength(1);
      expect(res.body.boards).toHaveLength(1);
      expect(res.body.boards[0].lists).toHaveLength(1);
      expect(res.body.boards[0].labels).toHaveLength(1);
    });
  });

  describe("GET /trello/today", () => {
    it("returns 503 when creds are missing", async () => {
      requireCredsMock.mockImplementation(() => {
        throw new MissingTrelloCredsError(["TRELLO_BOARD_ID"]);
      });
      const res = await request(buildApp()).get("/trello/today");
      expect(res.status).toBe(503);
    });

    it("runs a dry-run reorder", async () => {
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue(fakeClient() as never);
      runReorderMock.mockResolvedValueOnce({
        today: "2026-05-11",
        planned: 0,
        moved: 0,
        reordered: 0,
        unchanged: 0,
        errors: [],
        ops: [],
      });
      const res = await request(buildApp()).get("/trello/today");
      expect(res.status).toBe(200);
      expect(res.body.dry_run).toBe(true);
      expect(runReorderMock.mock.calls[0][2].dryRun).toBe(true);
    });
  });

  describe("POST /trello/reorder", () => {
    it("returns 503 when creds are missing", async () => {
      requireCredsMock.mockImplementation(() => {
        throw new MissingTrelloCredsError([]);
      });
      const res = await request(buildApp()).post("/trello/reorder");
      expect(res.status).toBe(503);
    });

    it("runs a non-dry reorder by default", async () => {
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue(fakeClient() as never);
      runReorderMock.mockResolvedValueOnce({
        today: "2026-05-11",
        planned: 2,
        moved: 1,
        reordered: 1,
        unchanged: 0,
        errors: [],
        ops: [],
      });
      const res = await request(buildApp()).post("/trello/reorder");
      expect(res.body.dry_run).toBe(false);
      expect(res.body.moved).toBe(1);
      expect(runReorderMock.mock.calls[0][2].dryRun).toBe(false);
    });

    it("honors dry_run=true query param", async () => {
      requireCredsMock.mockReturnValue(CREDS);
      makeClientMock.mockReturnValue(fakeClient() as never);
      runReorderMock.mockResolvedValueOnce({
        today: "",
        planned: 0,
        moved: 0,
        reordered: 0,
        unchanged: 0,
        errors: [],
        ops: [],
      });
      const res = await request(buildApp()).post("/trello/reorder?dry_run=true");
      expect(res.body.dry_run).toBe(true);
    });
  });
});
