import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";

vi.mock("../integrations/google/sheets-transactions.js", () => ({
  readTransactionsSheet: vi.fn(),
  readCategoriesEnum: vi.fn(),
}));

import {
  readCategoriesEnum,
  readTransactionsSheet,
  type TransactionRow,
  type TransactionsTab,
} from "../integrations/google/sheets-transactions.js";
import {
  addSituationalMerchant,
  consolidateRules,
  containsMerchantMatch,
  findConsolidations,
  inferTransactionRules,
} from "./transaction-rules.js";
import type { RuleRow } from "../rules/engine.js";

const readSheet = vi.mocked(readTransactionsSheet);
const readEnum = vi.mocked(readCategoriesEnum);

const TARGET = {
  sheetId: "sheet-1",
  transactionsTab: "Transactions",
  categoriesTab: "Categories",
};

const CANON = ["Groceries", "Dining", "Income"];

function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    rowIndex: 0,
    transactionId: `tx-${Math.random().toString(36).slice(2, 8)}`,
    date: "5/10/2026",
    description: "Foo Merchant",
    fullDescription: "FOO MERCHANT FULL",
    amount: "-$10.00",
    account: "Checking",
    institution: "Chase",
    categoryHint: "",
    source: "",
    category: "",
    categorizedBy: "",
    categorizedDate: "",
    ...overrides,
  };
}

function tabWith(rows: TransactionRow[]): TransactionsTab {
  return {
    tab: "Transactions",
    headers: [],
    columnIndex: { transactionId: 10, category: 3, categorizedBy: 16, categorizedDate: 17 },
    rows,
  };
}

describe("inferTransactionRules", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    readSheet.mockReset();
    readEnum.mockReset();
  });

  it("creates one rule per (description, canonical category) group", async () => {
    readSheet.mockResolvedValueOnce(
      tabWith([
        row({ transactionId: "tx-1", fullDescription: "AMAZON", category: "Groceries" }),
        row({ transactionId: "tx-2", fullDescription: "AMAZON", category: "Groceries" }),
        row({ transactionId: "tx-3", fullDescription: "STARBUCKS", category: "Dining" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(2);
    expect(r.groups_examined).toBe(2);
    const created = await db.select().from(rules);
    expect(created.map((c) => c.name).sort()).toEqual(["auto: AMAZON", "auto: STARBUCKS"]);
    expect(created.find((c) => c.name === "auto: AMAZON")?.action).toMatchObject({
      category: "Groceries",
    });
    expect(created.find((c) => c.name === "auto: AMAZON")?.match).toEqual({
      op: "equals",
      field: "full_description",
      value: "AMAZON",
    });
    expect(created.every((c) => c.createdBy === "bootstrap")).toBe(true);
  });

  it("skips rows whose Category is not in the canonical enum (Tiller leftovers)", async () => {
    readSheet.mockResolvedValueOnce(
      tabWith([
        row({ fullDescription: "AMAZON", category: "Electronics/General Merchandise" }),
        row({ fullDescription: "STARBUCKS", category: "Restaurants" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(0);
    expect(r.tiller_skipped).toBe(2);
    expect(await db.select().from(rules)).toEqual([]);
  });

  it("skips rows with empty Category", async () => {
    readSheet.mockResolvedValueOnce(
      tabWith([
        row({ fullDescription: "AMAZON", category: "" }),
        row({ fullDescription: "STARBUCKS", category: "  " }),
      ]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(0);
    expect(r.empty_skipped).toBe(2);
  });

  it("falls back to description when full_description is missing", async () => {
    readSheet.mockResolvedValueOnce(
      tabWith([
        row({ description: "Walmart", fullDescription: "", category: "Groceries" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(1);
    const [created] = await db.select().from(rules);
    expect(created.match).toEqual({ op: "equals", field: "description", value: "Walmart" });
  });

  it("skips rows with no description or full_description at all", async () => {
    readSheet.mockResolvedValueOnce(
      tabWith([row({ description: "  ", fullDescription: "", category: "Groceries" })]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(0);
    expect(r.no_key_skipped).toBe(1);
  });

  it("marks groups with conflicting canonical categories as ambiguous", async () => {
    readSheet.mockResolvedValueOnce(
      tabWith([
        row({ fullDescription: "AMAZON", category: "Groceries" }),
        row({ fullDescription: "AMAZON", category: "Dining" }),
        row({ fullDescription: "AMAZON", category: "Groceries" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(0);
    expect(r.ambiguous).toBe(1);
    expect(await db.select().from(rules)).toEqual([]);
  });

  it("skips description keys already covered by an existing rule", async () => {
    await db.insert(rules).values({
      domain: "transaction",
      name: "manual: AMAZON",
      match: { op: "equals", field: "full_description", value: "AMAZON" } as never,
      action: { category: "Groceries" } as never,
      createdBy: "manual",
    });
    readSheet.mockResolvedValueOnce(
      tabWith([
        row({ fullDescription: "AMAZON", category: "Groceries" }),
        row({ fullDescription: "NEW MERCHANT", category: "Dining" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(1);
    expect(r.already_exists).toBe(1);
    const all = await db.select().from(rules);
    expect(all.map((a) => a.name).sort()).toEqual(["auto: NEW MERCHANT", "manual: AMAZON"]);
  });

  it("is idempotent — a second run creates no new rules", async () => {
    readSheet.mockResolvedValue(
      tabWith([row({ fullDescription: "AMAZON", category: "Groceries" })]),
    );
    readEnum.mockResolvedValue(CANON);
    const first = await inferTransactionRules({} as never, TARGET);
    expect(first.created).toBe(1);
    const second = await inferTransactionRules({} as never, TARGET);
    expect(second.created).toBe(0);
    expect(second.already_exists).toBe(1);
    expect((await db.select().from(rules)).length).toBe(1);
  });

  it("only inspects domain=transaction rules when deduping", async () => {
    // An email-domain rule with the same value should NOT block creation.
    await db.insert(rules).values({
      domain: "email",
      name: "email rule",
      match: { op: "equals", field: "full_description", value: "AMAZON" } as never,
      action: { category: "noise" } as never,
      createdBy: "manual",
    });
    readSheet.mockResolvedValueOnce(
      tabWith([row({ fullDescription: "AMAZON", category: "Groceries" })]),
    );
    readEnum.mockResolvedValueOnce(CANON);
    const r = await inferTransactionRules({} as never, TARGET);
    expect(r.created).toBe(1);
  });
});

function exactRule(id: number, value: string, category: string, enabled = true): RuleRow {
  return {
    id,
    enabled,
    match: { op: "equals", field: "full_description", value },
    action: { category, reasoning: "x" },
  } as never;
}

describe("containsMerchantMatch", () => {
  it("builds an any/contains condition over both description fields", () => {
    expect(containsMerchantMatch("  Amazon ")).toEqual({
      any: [
        { op: "contains", field: "description", value: "Amazon" },
        { op: "contains", field: "full_description", value: "Amazon" },
      ],
    });
  });
});

describe("findConsolidations", () => {
  it("suggests consolidating exact rules sharing a token and category", () => {
    const s = findConsolidations([
      exactRule(1, "AMZN Mktp US*1A2B", "Shopping"),
      exactRule(2, "AMZN Mktp US*9X8Y", "Shopping"),
      exactRule(3, "AMZN Mktp US*ZZZZ", "Shopping"),
      exactRule(4, "STARBUCKS #441", "Dining"),
    ]);
    const amzn = s.find((x) => x.token === "amzn");
    expect(amzn).toBeDefined();
    expect(amzn!.category).toBe("Shopping");
    expect(amzn!.rules.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it("does not group rules across different categories", () => {
    const s = findConsolidations([
      exactRule(1, "AMZN Mktp one", "Shopping"),
      exactRule(2, "AMZN Mktp two", "Groceries"),
    ]);
    expect(s).toHaveLength(0);
  });

  it("ignores disabled rules and non-equals rules", () => {
    const s = findConsolidations([
      exactRule(1, "AMZN Mktp one", "Shopping", false),
      exactRule(2, "AMZN Mktp two", "Shopping"),
      { id: 3, enabled: true, match: containsMerchantMatch("amzn"), action: { category: "Shopping" } } as never,
    ]);
    expect(s).toHaveLength(0);
  });
});

describe("addSituationalMerchant", () => {
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

  it("inserts a priority-10 marker rule with a situational action", async () => {
    const r = await addSituationalMerchant("amazon");
    expect(r.action).toEqual({ situational: true });
    expect(r.priority).toBe(10);
    expect(r.match).toEqual(containsMerchantMatch("amazon"));
    expect(r.createdBy).toBe("situational");
  });

  it("is idempotent — adding the same merchant reuses the rule", async () => {
    const a = await addSituationalMerchant("amazon");
    const b = await addSituationalMerchant("amazon");
    expect(b.id).toBe(a.id);
    expect(await db.select().from(rules)).toHaveLength(1);
  });
});

describe("consolidateRules", () => {
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

  it("creates one contains rule and deletes the exact rules it replaces", async () => {
    const inserted = await db
      .insert(rules)
      .values([
        {
          domain: "transaction",
          name: "auto: AMZN 1",
          match: { op: "equals", field: "full_description", value: "AMZN 1" } as never,
          action: { category: "Shopping" } as never,
          createdBy: "bootstrap",
        },
        {
          domain: "transaction",
          name: "auto: AMZN 2",
          match: { op: "equals", field: "full_description", value: "AMZN 2" } as never,
          action: { category: "Shopping" } as never,
          createdBy: "bootstrap",
        },
      ])
      .returning();
    const rule = await consolidateRules({
      token: "amzn",
      category: "Shopping",
      ruleIds: inserted.map((r) => r.id),
    });
    expect(rule.match).toEqual(containsMerchantMatch("amzn"));
    expect(rule.action).toMatchObject({ category: "Shopping" });
    const remaining = await db.select().from(rules);
    expect(remaining.map((r) => r.id)).toEqual([rule.id]);
  });
});
