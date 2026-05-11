import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../integrations/google/sheets.js", async () => {
  const actual = await vi.importActual<typeof import("../integrations/google/sheets.js")>(
    "../integrations/google/sheets.js",
  );
  return {
    ...actual,
    getFirstSheetTitle: vi.fn(),
    readContactsTab: vi.fn(),
    batchUpdateCells: vi.fn(),
    getSheetIdByTitle: vi.fn(),
    deleteDataRows: vi.fn(),
  };
});

import {
  batchUpdateCells,
  deleteDataRows,
  getFirstSheetTitle,
  getSheetIdByTitle,
  readContactsTab,
} from "../integrations/google/sheets.js";
import { runDedupe } from "./dedupe-runner.js";

const titleMock = vi.mocked(getFirstSheetTitle);
const readMock = vi.mocked(readContactsTab);
const writeMock = vi.mocked(batchUpdateCells);
const sheetIdMock = vi.mocked(getSheetIdByTitle);
const deleteMock = vi.mocked(deleteDataRows);

function mockSheet(rows: { rowIndex: number; record: Record<string, string> }[]): void {
  titleMock.mockResolvedValueOnce("Contacts");
  readMock.mockResolvedValueOnce({
    tab: "Contacts",
    headers: ["google_resource_name", "full_name", "email"],
    rows,
  } as never);
}

beforeEach(() => {
  titleMock.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  sheetIdMock.mockReset();
  deleteMock.mockReset();
});

describe("runDedupe", () => {
  it("dry-run returns a plan + summary without writing or deleting", async () => {
    mockSheet([
      { rowIndex: 0, record: { google_resource_name: "p/1", full_name: "Jane", email: "j@x" } },
      { rowIndex: 1, record: { google_resource_name: "p/1", full_name: "Jane", email: "j@x" } },
    ]);
    const result = await runDedupe({} as never, "ss", { dryRun: true });
    expect(result.applied).toBe(false);
    expect(result.tab).toBe("Contacts");
    expect(writeMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("apply path issues batch update + delete in sequence", async () => {
    mockSheet([
      { rowIndex: 0, record: { google_resource_name: "p/1", full_name: "Jane", email: "" } },
      { rowIndex: 1, record: { google_resource_name: "p/1", full_name: "", email: "j@x" } },
    ]);
    sheetIdMock.mockResolvedValueOnce(123);
    writeMock.mockResolvedValueOnce(undefined);
    deleteMock.mockResolvedValueOnce(undefined);

    const result = await runDedupe({} as never, "ss", { dryRun: false });
    expect(result.applied).toBe(true);
    // a merge into row 0 plus a delete of row 1
    expect(writeMock).toHaveBeenCalledOnce();
    expect(deleteMock).toHaveBeenCalledWith({}, "ss", 123, expect.any(Array));
  });

  it("respects an explicit tab option", async () => {
    readMock.mockResolvedValueOnce({
      tab: "Other",
      headers: ["google_resource_name", "full_name"],
      rows: [],
    } as never);
    const result = await runDedupe({} as never, "ss", { dryRun: true, tab: "Other" });
    expect(titleMock).not.toHaveBeenCalled();
    expect(result.tab).toBe("Other");
  });
});
