import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { clearAppliers } from "../../tests/helpers/registry.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";

vi.mock("../integrations/google/sheets.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/sheets.js")>(
    "../integrations/google/sheets.js",
  );
  return {
    ...actual,
    readContactsTab: vi.fn(),
    appendRows: vi.fn(),
    batchUpdateCells: vi.fn(),
  };
});

import {
  appendRows,
  batchUpdateCells,
  readContactsTab,
} from "../integrations/google/sheets.js";
import { reviewAppliers } from "../needs-review/appliers.js";
import {
  CONTACT_AMBIGUOUS_KIND,
  CONTACT_INSERT_KIND,
  CONTACT_REFRESH_KIND,
  type RefreshReviewAction,
  type InsertReviewAction,
  type AmbiguousReviewAction,
} from "./contacts-review.js";
import { registerContactReviewAppliers } from "./contacts-applier.js";

const readMock = vi.mocked(readContactsTab);
const appendMock = vi.mocked(appendRows);
const writeMock = vi.mocked(batchUpdateCells);

const META = { sessionId: "s", caller: "c", intent: "i" };

function tabWith(rows: { rowIndex: number; record: Record<string, string> }[]) {
  return {
    tab: "Contacts",
    headers: ["google_resource_name", "full_name", "email"],
    rows,
  };
}

describe("contacts-applier", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    clearAppliers();
    readMock.mockReset();
    appendMock.mockReset();
    writeMock.mockReset();
    registerContactReviewAppliers({} as never, { spreadsheetId: "sheet-1" });
  });

  describe("CONTACT_REFRESH_KIND applier (stale-row-index resilience)", () => {
    it("finds the row by google_resource_name even if action.row_index is stale", async () => {
      // Queue captured the row at index 5, but the live sheet now has it at 2.
      const action: RefreshReviewAction = {
        type: "refresh",
        tab: "Contacts",
        row_index: 5,
        via: "resource_name",
        updates: [{ col: "full_name", from: "Old Name", to: "New Name" }],
      };
      readMock.mockResolvedValueOnce(
        tabWith([
          { rowIndex: 0, record: { google_resource_name: "people/other-1" } },
          { rowIndex: 1, record: { google_resource_name: "people/other-2" } },
          {
            rowIndex: 2,
            record: { google_resource_name: "people/c1", full_name: "Old Name" },
          },
        ]) as never,
      );
      writeMock.mockResolvedValueOnce(undefined);

      const result = await reviewAppliers.apply(
        CONTACT_REFRESH_KIND,
        "people/c1",
        action,
        META,
      );
      // The write should target sheet row 2 + 2 = 4, NOT 5 + 2 = 7.
      expect(writeMock).toHaveBeenCalledOnce();
      expect(writeMock.mock.calls[0][2]).toEqual([
        { range: "Contacts!B4", value: "New Name" },
      ]);
      expect(result).toMatchObject({ refreshed: 1, row_index: 2 });
    });

    it("throws when the resource_name is no longer in the sheet", async () => {
      const action: RefreshReviewAction = {
        type: "refresh",
        tab: "Contacts",
        row_index: 0,
        via: "resource_name",
        updates: [{ col: "full_name", from: "x", to: "y" }],
      };
      readMock.mockResolvedValueOnce(tabWith([]) as never);
      await expect(
        reviewAppliers.apply(CONTACT_REFRESH_KIND, "people/missing", action, META),
      ).rejects.toThrow(/not found in tab/);
      expect(writeMock).not.toHaveBeenCalled();
    });

    it("logs the *live* before value in the changelog (not the captured one)", async () => {
      // Queue captured from="Stale" but the sheet now shows "Live" — log Live.
      const action: RefreshReviewAction = {
        type: "refresh",
        tab: "Contacts",
        row_index: 0,
        via: "email",
        updates: [{ col: "email", from: "stale@x", to: "new@x" }],
      };
      readMock.mockResolvedValueOnce(
        tabWith([
          {
            rowIndex: 0,
            record: { google_resource_name: "people/c1", email: "live@x" },
          },
        ]) as never,
      );
      writeMock.mockResolvedValueOnce(undefined);
      await reviewAppliers.apply(CONTACT_REFRESH_KIND, "people/c1", action, META);
      const [row] = await db.select().from(changelog);
      expect(row.beforeState).toEqual({ email: "live@x" });
      expect(row.afterState).toEqual({ email: "new@x" });
    });

    it("skips updates for columns no longer in the headers", async () => {
      const action: RefreshReviewAction = {
        type: "refresh",
        tab: "Contacts",
        row_index: 0,
        via: "resource_name",
        updates: [
          { col: "full_name", from: "", to: "X" },
          { col: "deleted_column", from: "", to: "Y" },
        ],
      };
      readMock.mockResolvedValueOnce(
        tabWith([{ rowIndex: 0, record: { google_resource_name: "people/c1" } }]) as never,
      );
      writeMock.mockResolvedValueOnce(undefined);
      const result = await reviewAppliers.apply(
        CONTACT_REFRESH_KIND,
        "people/c1",
        action,
        META,
      );
      expect(result).toMatchObject({ refreshed: 1 });
      const call = writeMock.mock.calls[0][2];
      expect(call).toHaveLength(1);
      expect(call[0].range).toBe("Contacts!B2");
    });
  });

  describe("CONTACT_INSERT_KIND applier", () => {
    it("appends the row and logs a changelog entry", async () => {
      const action: InsertReviewAction = {
        type: "insert",
        tab: "Contacts",
        headers: ["google_resource_name", "full_name", "email"],
        values: ["people/c1", "Jane", "j@x"],
      };
      appendMock.mockResolvedValueOnce(undefined);
      const result = await reviewAppliers.apply(
        CONTACT_INSERT_KIND,
        "people/c1",
        action,
        META,
      );
      expect(appendMock).toHaveBeenCalledWith({}, "sheet-1", "Contacts", [
        ["people/c1", "Jane", "j@x"],
      ]);
      expect(result).toMatchObject({ inserted: true, tab: "Contacts", columns: 3 });
      const rows = await db.select().from(changelog);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operation: "contacts.review.insert",
        targetId: "people/c1",
        status: "success",
      });
    });

    it("rejects a non-insert decision", async () => {
      const wrong = { type: "refresh" } as never;
      await expect(
        reviewAppliers.apply(CONTACT_INSERT_KIND, "people/c1", wrong, META),
      ).rejects.toThrow(/expected insert/);
    });
  });

  describe("CONTACT_AMBIGUOUS_KIND applier", () => {
    it("always throws with a hint to clean up via the audit panel", async () => {
      const action: AmbiguousReviewAction = {
        type: "ambiguous",
        tab: "Contacts",
        matches: [1, 2],
        via: "email",
      };
      await expect(
        reviewAppliers.apply(CONTACT_AMBIGUOUS_KIND, "people/c1", action, META),
      ).rejects.toThrow(/audit panel/);
    });
  });
});
