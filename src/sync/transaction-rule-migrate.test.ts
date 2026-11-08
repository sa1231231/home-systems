import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";
import { dbRuleToSheet, seedRuleTabsFromDb, type SheetWriters } from "./transaction-rule-migrate.js";

describe("dbRuleToSheet", () => {
  it("maps an equals rule", () => {
    expect(
      dbRuleToSheet({ op: "equals", field: "full_description", value: "RENT CO" }, { category: "Rent" }),
    ).toEqual({ kind: "rule", value: "RENT CO", type: "equals", category: "Rent" });
  });

  it("maps a contains (any) rule to a contains row", () => {
    const match = {
      any: [
        { op: "contains", field: "description", value: "amazon" },
        { op: "contains", field: "full_description", value: "amazon" },
      ],
    };
    expect(dbRuleToSheet(match, { category: "Shopping" })).toEqual({
      kind: "rule",
      value: "amazon",
      type: "contains",
      category: "Shopping",
    });
  });

  it("maps a situational marker", () => {
    const match = { any: [{ op: "contains", field: "description", value: "costco" }] };
    expect(dbRuleToSheet(match, { situational: true })).toEqual({
      kind: "situational",
      value: "costco",
    });
  });

  it("returns null for shapes the sheet can't express", () => {
    expect(dbRuleToSheet({ all: [{ op: "present", field: "x" }] }, { category: "Y" })).toBeNull();
    expect(dbRuleToSheet({ op: "equals", field: "full_description", value: "x" }, {})).toBeNull();
  });
});

describe("seedRuleTabsFromDb", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
  });

  function captureWriters() {
    const calls: { ensure: string[]; replace: { tab: string; rows: unknown[][] }[] } = {
      ensure: [],
      replace: [],
    };
    const writers: SheetWriters = {
      ensureTab: vi.fn(async (_c, _s, title) => {
        calls.ensure.push(title);
        return { created: true };
      }),
      replaceTabData: vi.fn(async (_c, _s, title, _headers, rows) => {
        calls.replace.push({ tab: title, rows });
      }),
    };
    return { writers, calls };
  }

  it("writes DB rules into the rule + situational tabs and skips odd shapes", async () => {
    await db.insert(rules).values([
      {
        domain: "transaction",
        name: "r1",
        match: { op: "equals", field: "full_description", value: "RENT CO" },
        action: { category: "Rent" },
        priority: 50,
        enabled: true,
        createdBy: "test",
      },
      {
        domain: "transaction",
        name: "r2",
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
      // Different domain — must be ignored.
      {
        domain: "contact",
        name: "c1",
        match: { op: "present", field: "google_resource_name" },
        action: { category: "x" },
        priority: 100,
        enabled: true,
        createdBy: "test",
      },
    ]);

    const { writers, calls } = captureWriters();
    const res = await seedRuleTabsFromDb(
      {} as never,
      { sheetId: "s", rulesTab: "HS Rules", situationalTab: "HS Situational" },
      { database: db, writers },
    );

    expect(res).toEqual({ rulesWritten: 1, situationalWritten: 1, skipped: 1 });
    expect(calls.ensure).toEqual(["HS Rules", "HS Situational"]);
    const rulesWrite = calls.replace.find((w) => w.tab === "HS Rules");
    expect(rulesWrite?.rows).toEqual([["RENT CO", "equals", "Rent", 50, "TRUE", ""]]);
    const sitWrite = calls.replace.find((w) => w.tab === "HS Situational");
    expect(sitWrite?.rows).toEqual([["costco", ""]]);
  });

  it("writes empty tabs when there are no transaction rules", async () => {
    const { writers, calls } = captureWriters();
    const res = await seedRuleTabsFromDb(
      {} as never,
      { sheetId: "s", rulesTab: "HS Rules", situationalTab: "HS Situational" },
      { database: db, writers },
    );
    expect(res).toEqual({ rulesWritten: 0, situationalWritten: 0, skipped: 0 });
    expect(calls.replace.every((w) => w.rows.length === 0)).toBe(true);
  });
});
