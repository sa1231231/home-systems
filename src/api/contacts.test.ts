import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";

vi.mock("../integrations/google/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/oauth.js")>(
    "../integrations/google/oauth.js",
  );
  return {
    ...actual,
    getOAuthClient: vi.fn(),
    requireGoogleCreds: vi.fn(),
  };
});
vi.mock("../integrations/google/people.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/people.js")>(
    "../integrations/google/people.js",
  );
  return { ...actual, listConnections: vi.fn() };
});
vi.mock("../integrations/google/sheets.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/sheets.js")>(
    "../integrations/google/sheets.js",
  );
  return { ...actual, previewSheet: vi.fn() };
});
vi.mock("../sync/contacts.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/contacts.js")>(
    "../sync/contacts.js",
  );
  return { ...actual, runSync: vi.fn() };
});
vi.mock("../sync/dedupe-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/dedupe-runner.js")>(
    "../sync/dedupe-runner.js",
  );
  return { ...actual, runDedupe: vi.fn() };
});
vi.mock("../sync/contact-writes.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/contact-writes.js")>(
    "../sync/contact-writes.js",
  );
  return {
    ...actual,
    addToCsvField: vi.fn(),
    removeFromCsvField: vi.fn(),
    setBoolField: vi.fn(),
  };
});

import {
  getOAuthClient,
  MissingGoogleCredsError,
  requireGoogleCreds,
} from "../integrations/google/oauth.js";
import { listConnections } from "../integrations/google/people.js";
import { previewSheet } from "../integrations/google/sheets.js";
import { runSync } from "../sync/contacts.js";
import { runDedupe } from "../sync/dedupe-runner.js";
import {
  addToCsvField,
  ContactNotFoundError,
  removeFromCsvField,
  setBoolField,
  UnknownColumnError,
} from "../sync/contact-writes.js";
import { makeContactsRouter } from "./contacts.js";

const requireCredsMock = vi.mocked(requireGoogleCreds);
const oauthMock = vi.mocked(getOAuthClient);
const listPeopleMock = vi.mocked(listConnections);
const previewMock = vi.mocked(previewSheet);
const syncMock = vi.mocked(runSync);
const dedupeMock = vi.mocked(runDedupe);
const addMock = vi.mocked(addToCsvField);
const removeMock = vi.mocked(removeFromCsvField);
const boolMock = vi.mocked(setBoolField);

const CREDS = {
  clientId: "x",
  clientSecret: "y",
  refreshToken: "z",
  sheetId: "sheet-1",
};

function buildApp() {
  const app = makeTestApp();
  app.use("/contacts", makeContactsRouter());
  return app;
}

describe("api/contacts", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    requireCredsMock.mockReset();
    oauthMock.mockReset();
    listPeopleMock.mockReset();
    previewMock.mockReset();
    syncMock.mockReset();
    dedupeMock.mockReset();
    addMock.mockReset();
    removeMock.mockReset();
    boolMock.mockReset();
  });

  describe("GET /contacts/google/preview", () => {
    it("returns the list of people from google.people", async () => {
      oauthMock.mockReturnValue({} as never);
      listPeopleMock.mockResolvedValueOnce([
        { resource_name: "p/1", display_name: "Jane" } as never,
      ]);
      const res = await request(buildApp()).get("/contacts/google/preview");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });
  });

  describe("GET /contacts/sheet/preview", () => {
    it("returns 503 when creds missing", async () => {
      requireCredsMock.mockImplementation(() => {
        throw new MissingGoogleCredsError();
      });
      const res = await request(buildApp()).get("/contacts/sheet/preview");
      expect(res.status).toBe(503);
    });

    it("returns preview rows when configured", async () => {
      requireCredsMock.mockReturnValue(CREDS);
      oauthMock.mockReturnValue({} as never);
      previewMock.mockResolvedValueOnce({
        tab: "T",
        headers: ["a"],
        rows: [{ a: "1" }, { a: "2" }],
      });
      const res = await request(buildApp()).get("/contacts/sheet/preview");
      expect(res.body.count).toBe(2);
      expect(res.body.tab).toBe("T");
    });
  });

  describe("GET /contacts/sync/plan and POST /contacts/sync", () => {
    it("plan is dry-run, post sync applies", async () => {
      requireCredsMock.mockReturnValue(CREDS);
      oauthMock.mockReturnValue({} as never);
      const baseResult = {
        plan: { inserts: [], refreshes: [], ambiguous: [], needsHeaderUpdate: false } as never,
        applied: false,
        summary: { inserted: 0, refreshed: 0, unchanged: 0, ambiguous: 0 },
      };
      syncMock.mockResolvedValueOnce(baseResult);
      const planRes = await request(buildApp()).get("/contacts/sync/plan");
      expect(planRes.body.dry_run).toBe(true);

      syncMock.mockResolvedValueOnce({ ...baseResult, applied: true });
      const syncRes = await request(buildApp()).post("/contacts/sync");
      expect(syncRes.body.applied).toBe(true);
      expect(syncMock.mock.calls[1][2]?.dryRun).toBe(false);
    });
  });

  describe("GET /contacts/dedupe/plan and POST /contacts/dedupe", () => {
    it("plan is dry-run, post dedupe applies", async () => {
      requireCredsMock.mockReturnValue(CREDS);
      oauthMock.mockReturnValue({} as never);
      const baseResult = {
        plan: { merges: [], rowsToDelete: [] },
        applied: false,
        summary: { merges: 0, rowsToDelete: 0 },
        tab: "T",
        headers: [],
      };
      dedupeMock.mockResolvedValueOnce(baseResult as never);
      const planRes = await request(buildApp()).get("/contacts/dedupe/plan");
      expect(planRes.body.dry_run).toBe(true);

      dedupeMock.mockResolvedValueOnce({ ...baseResult, applied: true } as never);
      const dedupeRes = await request(buildApp()).post("/contacts/dedupe");
      expect(dedupeRes.body.applied).toBe(true);
    });
  });

  describe("write endpoints", () => {
    beforeEach(() => {
      requireCredsMock.mockReturnValue(CREDS);
      oauthMock.mockReturnValue({} as never);
    });

    it("POST /contacts/add-groups validates body shape", async () => {
      const res = await request(buildApp())
        .post("/contacts/add-groups")
        .send({ resource_name: "not-a-people-name", values: [] });
      expect(res.status).toBe(400);
    });

    it("POST /contacts/add-groups dispatches to addToCsvField", async () => {
      addMock.mockResolvedValueOnce({
        resource_name: "people/c1",
        row_index: 0,
        field: "groups",
        value: "A",
        changed: true,
      });
      const res = await request(buildApp())
        .post("/contacts/add-groups")
        .send({ resource_name: "people/c1", values: ["A"] });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);
      expect(addMock.mock.calls[0][3]).toBe("groups");
    });

    it("POST /contacts/add-tags dispatches to addToCsvField with field=tags", async () => {
      addMock.mockResolvedValueOnce({
        resource_name: "people/c1",
        row_index: 0,
        field: "tags",
        value: "A",
        changed: true,
      });
      await request(buildApp())
        .post("/contacts/add-tags")
        .send({ resource_name: "people/c1", values: ["A"] });
      expect(addMock.mock.calls[0][3]).toBe("tags");
    });

    it("POST /contacts/remove-groups dispatches to removeFromCsvField", async () => {
      removeMock.mockResolvedValueOnce({
        resource_name: "people/c1",
        row_index: 0,
        field: "groups",
        value: "",
        changed: true,
      });
      const res = await request(buildApp())
        .post("/contacts/remove-groups")
        .send({ resource_name: "people/c1", values: ["A"] });
      expect(res.status).toBe(200);
      expect(removeMock.mock.calls[0][3]).toBe("groups");
    });

    it("POST /contacts/set-archived dispatches to setBoolField with field=is_archived", async () => {
      boolMock.mockResolvedValueOnce({
        resource_name: "people/c1",
        row_index: 0,
        field: "is_archived",
        value: true,
        changed: true,
      });
      await request(buildApp())
        .post("/contacts/set-archived")
        .send({ resource_name: "people/c1", value: true });
      expect(boolMock.mock.calls[0][3]).toBe("is_archived");
    });

    it("POST /contacts/set-starred dispatches with field=starred", async () => {
      boolMock.mockResolvedValueOnce({
        resource_name: "people/c1",
        row_index: 0,
        field: "starred",
        value: false,
        changed: false,
      });
      await request(buildApp())
        .post("/contacts/set-starred")
        .send({ resource_name: "people/c1", value: false });
      expect(boolMock.mock.calls[0][3]).toBe("starred");
    });

    it("returns 404 on ContactNotFoundError", async () => {
      addMock.mockRejectedValueOnce(new ContactNotFoundError("people/missing"));
      const res = await request(buildApp())
        .post("/contacts/add-groups")
        .send({ resource_name: "people/missing", values: ["A"] });
      expect(res.status).toBe(404);
      expect(res.body.resource_name).toBe("people/missing");
    });

    it("returns 409 on UnknownColumnError", async () => {
      addMock.mockRejectedValueOnce(new UnknownColumnError("groups"));
      const res = await request(buildApp())
        .post("/contacts/add-groups")
        .send({ resource_name: "people/c1", values: ["A"] });
      expect(res.status).toBe(409);
      expect(res.body.column).toBe("groups");
    });
  });
});
