import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";

vi.mock("../integrations/google/sheets.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/sheets.js")>(
    "../integrations/google/sheets.js",
  );
  return {
    ...actual,
    getFirstSheetTitle: vi.fn(),
    readContactsTab: vi.fn(),
    batchUpdateCells: vi.fn(),
  };
});

import {
  getFirstSheetTitle,
  readContactsTab,
  batchUpdateCells,
} from "../integrations/google/sheets.js";
import {
  addToCsvField,
  ContactNotFoundError,
  removeFromCsvField,
  setBoolField,
  UnknownColumnError,
} from "./contact-writes.js";

const titleMock = vi.mocked(getFirstSheetTitle);
const readMock = vi.mocked(readContactsTab);
const writeMock = vi.mocked(batchUpdateCells);

const META = { sessionId: "s", caller: "c", intent: "i" };

function mockSheet(opts: {
  tab?: string;
  headers: string[];
  rows: { rowIndex: number; record: Record<string, string> }[];
}): void {
  const tab = opts.tab ?? "Contacts";
  titleMock.mockResolvedValueOnce(tab);
  readMock.mockResolvedValueOnce({ tab, headers: opts.headers, rows: opts.rows } as never);
}

describe("contact-writes", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    titleMock.mockReset();
    readMock.mockReset();
    writeMock.mockReset();
  });

  describe("addToCsvField", () => {
    it("appends new values, writes the cell, and logs success", async () => {
      mockSheet({
        headers: ["google_resource_name", "groups", "tags"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1", groups: "A", tags: "" } }],
      });
      writeMock.mockResolvedValueOnce(undefined);
      const result = await addToCsvField({} as never, "ss", "p/1", "groups", ["B"], META);
      expect(result).toMatchObject({ resource_name: "p/1", field: "groups", value: "A, B", changed: true });
      expect(writeMock).toHaveBeenCalledOnce();
      const writeCall = writeMock.mock.calls[0];
      expect(writeCall[2]).toEqual([{ range: "Contacts!B2", value: "A, B" }]);

      const logs = await db.select().from(changelog);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        operation: "contacts.add_csv.groups",
        targetKind: "contact",
        targetId: "p/1",
        status: "success",
      });
      expect(logs[0].beforeState).toEqual({ groups: "A" });
      expect(logs[0].afterState).toEqual({ groups: "A, B" });
    });

    it("returns changed=false and skips write when the value is already present", async () => {
      mockSheet({
        headers: ["google_resource_name", "groups"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1", groups: "A, B" } }],
      });
      const result = await addToCsvField({} as never, "ss", "p/1", "groups", ["A"], META);
      expect(result.changed).toBe(false);
      expect(writeMock).not.toHaveBeenCalled();
      expect(await db.select().from(changelog)).toEqual([]);
    });

    it("throws ContactNotFoundError when the resource name isn't in the sheet", async () => {
      mockSheet({
        headers: ["google_resource_name", "groups"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "other" } }],
      });
      await expect(
        addToCsvField({} as never, "ss", "p/missing", "groups", ["X"], META),
      ).rejects.toBeInstanceOf(ContactNotFoundError);
    });

    it("throws UnknownColumnError when the field column is missing from headers", async () => {
      mockSheet({
        headers: ["google_resource_name"], // no groups column
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1" } }],
      });
      await expect(
        addToCsvField({} as never, "ss", "p/1", "groups", ["X"], META),
      ).rejects.toBeInstanceOf(UnknownColumnError);
    });
  });

  describe("removeFromCsvField", () => {
    it("removes existing values, writes the cell, and logs success", async () => {
      mockSheet({
        headers: ["google_resource_name", "groups"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1", groups: "A,B,C" } }],
      });
      writeMock.mockResolvedValueOnce(undefined);
      const result = await removeFromCsvField({} as never, "ss", "p/1", "groups", ["B"], META);
      expect(result.changed).toBe(true);
      expect(result.value).toBe("A, C");
      const logs = await db.select().from(changelog);
      expect(logs[0]).toMatchObject({ operation: "contacts.remove_csv.groups" });
    });

    it("changed=false when the value isn't present", async () => {
      mockSheet({
        headers: ["google_resource_name", "tags"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1", tags: "x" } }],
      });
      const result = await removeFromCsvField({} as never, "ss", "p/1", "tags", ["y"], META);
      expect(result.changed).toBe(false);
      expect(writeMock).not.toHaveBeenCalled();
    });
  });

  describe("setBoolField", () => {
    it("writes TRUE/FALSE strings and logs the typed value", async () => {
      mockSheet({
        headers: ["google_resource_name", "is_archived"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1", is_archived: "FALSE" } }],
      });
      writeMock.mockResolvedValueOnce(undefined);
      const result = await setBoolField({} as never, "ss", "p/1", "is_archived", true, META);
      expect(result).toMatchObject({ field: "is_archived", value: true, changed: true });
      const writeCall = writeMock.mock.calls[0];
      expect(writeCall[2]).toEqual([{ range: "Contacts!B2", value: "TRUE" }]);
      const logs = await db.select().from(changelog);
      expect(logs[0].beforeState).toEqual({ is_archived: false });
      expect(logs[0].afterState).toEqual({ is_archived: true });
    });

    it("returns changed=false when the value is already what we want", async () => {
      mockSheet({
        headers: ["google_resource_name", "starred"],
        rows: [{ rowIndex: 0, record: { google_resource_name: "p/1", starred: "TRUE" } }],
      });
      const result = await setBoolField({} as never, "ss", "p/1", "starred", true, META);
      expect(result.changed).toBe(false);
      expect(writeMock).not.toHaveBeenCalled();
    });
  });
});
