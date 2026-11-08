import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";

vi.mock("./transaction-autocat.js", async () => {
  const actual =
    await vi.importActual<typeof import("./transaction-autocat.js")>("./transaction-autocat.js");
  return { ...actual, readAutoCat: vi.fn(), appendAutoCatRules: vi.fn() };
});

import { appendAutoCatRules, readAutoCat } from "./transaction-autocat.js";
import { migrateDbRulesToAutoCat } from "./transaction-autocat-migrate.js";

const readAutoCatMock = vi.mocked(readAutoCat);
const appendMock = vi.mocked(appendAutoCatRules);

describe("migrateDbRulesToAutoCat", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    readAutoCatMock.mockReset();
    appendMock.mockReset();
    appendMock.mockImplementation(async (_c, _s, _t, _h, candidates) => candidates.length);
  });

  it("reports tabMissing when the AutoCat tab is absent", async () => {
    readAutoCatMock.mockResolvedValueOnce(null);
    const res = await migrateDbRulesToAutoCat(
      {} as never,
      { sheetId: "s", autoCatTab: "AutoCat" },
      { database: db },
    );
    expect(res.tabMissing).toBe(true);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("appends new rules, dedupes existing, skips unsupported/situational", async () => {
    await db.insert(rules).values([
      {
        domain: "transaction",
        name: "rent",
        match: { op: "equals", field: "full_description", value: "RENT CO" },
        action: { category: "Rent" },
        priority: 100,
        enabled: true,
        createdBy: "test",
      },
      {
        domain: "transaction",
        name: "amazon",
        match: { any: [{ op: "contains", field: "description", value: "amazon" }] },
        action: { category: "Shopping" },
        priority: 100,
        enabled: true,
        createdBy: "test",
      },
      {
        domain: "transaction",
        name: "sit",
        match: { any: [{ op: "contains", field: "description", value: "costco" }] },
        action: { situational: true },
        priority: 10,
        enabled: true,
        createdBy: "test",
      },
      {
        domain: "transaction",
        name: "weird",
        match: { all: [{ op: "present", field: "x" }] },
        action: { category: "Misc" },
        priority: 100,
        enabled: true,
        createdBy: "test",
      },
    ]);

    // AutoCat already contains the Rent rule → should be deduped.
    const raw = [
      ["Description Contains", "Category"],
      ["RENT CO", "Rent"],
    ];
    readAutoCatMock.mockResolvedValueOnce({
      headers: ["Description Contains", "Category"],
      rules: [],
      raw,
    });

    const res = await migrateDbRulesToAutoCat(
      {} as never,
      { sheetId: "s", autoCatTab: "AutoCat" },
      { database: db },
    );

    expect(res).toEqual({
      appended: 1, // only Amazon
      skippedExisting: 1, // Rent already there
      skippedUnsupported: 2, // situational + composite
      tabMissing: false,
    });
    const appendedCandidates = appendMock.mock.calls[0][4];
    expect(appendedCandidates).toEqual([{ descriptionContains: "amazon", category: "Shopping" }]);
  });
});
