import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { clearAppliers } from "../../tests/helpers/registry.js";
import { db } from "../db/client.js";
import { needsReview, processedTransactions, rules } from "../db/schema.js";

// Mock the Sheet I/O so we drive triage from fixtures.
vi.mock("../integrations/google/sheets-transactions.js", () => ({
  readTransactionsSheet: vi.fn(),
  readCategoriesEnum: vi.fn(),
  writeTransactionCategory: vi.fn(),
}));

// Mock AI classify so we can drive the AI fallback path.
vi.mock("../ai/index.js", async () => {
  const actual = await vi.importActual<typeof import("../ai/index.js")>("../ai/index.js");
  return { ...actual, classify: vi.fn() };
});

// Mock the apply so rule-match path doesn't try to write back to a sheet.
vi.mock("./transaction-actions.js", () => ({
  applyTransactionCategory: vi.fn(),
  TRANSACTION_CATEGORIZE_OP: "transaction.categorize",
}));

import {
  readCategoriesEnum,
  readTransactionsSheet,
  type TransactionRow,
  type TransactionsTab,
} from "../integrations/google/sheets-transactions.js";
import { classify, ClassificationParseError, MissingAnthropicKeyError } from "../ai/index.js";
import { applyTransactionCategory } from "./transaction-actions.js";
import {
  applyRuleToSheet,
  registerTransactionApplier,
  triageTransactions,
  TRIAGE_DOMAIN,
} from "./transaction-triage.js";
import { reviewAppliers } from "../needs-review/appliers.js";

const readSheet = vi.mocked(readTransactionsSheet);
const readEnum = vi.mocked(readCategoriesEnum);
const classifyMock = vi.mocked(classify);
const applyMock = vi.mocked(applyTransactionCategory);

const TARGET = {
  sheetId: "sheet-1",
  transactionsTab: "Transactions",
  categoriesTab: "Categories",
};

function makeRow(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    rowIndex: 0,
    transactionId: `tx-${Math.random().toString(36).slice(2, 8)}`,
    date: "5/10/2026",
    description: "Foo Merchant",
    fullDescription: "FOO MERCHANT",
    amount: "-$10.00",
    account: "Checking",
    institution: "Chase",
    categoryHint: "General",
    source: "Yodlee",
    category: "",
    categorizedBy: "",
    categorizedDate: "",
    ...overrides,
  };
}

function makeTab(rows: TransactionRow[]): TransactionsTab {
  return {
    tab: "Transactions",
    headers: [],
    columnIndex: { transactionId: 10, category: 3, categorizedBy: 16, categorizedDate: 17 },
    rows,
  };
}

describe("triageTransactions", () => {
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
    readSheet.mockReset();
    readEnum.mockReset();
    classifyMock.mockReset();
    applyMock.mockReset();
  });

  it("skips rows that already have a non-empty Category in the sheet", async () => {
    readSheet.mockResolvedValueOnce(
      makeTab([
        makeRow({ transactionId: "tx-1", category: "Groceries" }),
        makeRow({ transactionId: "tx-2", category: "" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(["Groceries", "Dining"]);
    classifyMock.mockResolvedValueOnce({
      output: { category: "Dining", reasoning: "looks like dining" },
      callId: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      target: TARGET,
    });

    // tx-1 filtered out before we even consider it; tx-2 queued.
    expect(summary.total).toBe(1);
    expect(summary.queued).toBe(1);
    expect(classifyMock).toHaveBeenCalledOnce();
  });

  it("respects the limit when there are more uncategorized rows than asked", async () => {
    readSheet.mockResolvedValueOnce(
      makeTab([
        makeRow({ transactionId: "a" }),
        makeRow({ transactionId: "b" }),
        makeRow({ transactionId: "c" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(["X"]);
    classifyMock.mockResolvedValue({
      output: { category: "X", reasoning: "x" },
      callId: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never);

    const summary = await triageTransactions({} as never, {
      limit: 2,
      sessionId: "test",
      target: TARGET,
    });
    expect(summary.total).toBe(2);
    expect(summary.items.map((i) => i.transaction_id)).toEqual(["a", "b"]);
  });

  it("skips rows already processed with a success outcome", async () => {
    await db.insert(processedTransactions).values({
      id: "tx-done",
      outcome: "matched_rule",
      outcomeId: 99,
    });

    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-done" })]));
    readEnum.mockResolvedValueOnce(["X"]);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      target: TARGET,
    });
    expect(summary.skipped).toBe(1);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("excludes already-processed rows BEFORE applying the limit (no wasted slots)", async () => {
    // Five rows in the sheet; the first three are already in processed_transactions
    // as needs_review (success outcome). With limit=2, the old behavior took the
    // first two from the sheet → both were skipped → zero progress per click.
    // New behavior: filter alreadyDone first, then slice. Slots go to fresh work.
    await db.insert(processedTransactions).values([
      { id: "tx-A", outcome: "needs_review", outcomeId: 100 },
      { id: "tx-B", outcome: "needs_review", outcomeId: 101 },
      { id: "tx-C", outcome: "needs_review", outcomeId: 102 },
    ]);
    readSheet.mockResolvedValueOnce(
      makeTab([
        makeRow({ transactionId: "tx-A" }),
        makeRow({ transactionId: "tx-B" }),
        makeRow({ transactionId: "tx-C" }),
        makeRow({ transactionId: "tx-D" }),
        makeRow({ transactionId: "tx-E" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(["X"]);
    classifyMock.mockResolvedValue({
      output: { category: "X", reasoning: "x" },
      callId: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never);

    const summary = await triageTransactions({} as never, {
      limit: 2,
      sessionId: "test",
      target: TARGET,
    });
    // Skipped surfaces the 3 already-done rows; queued is the 2 fresh ones
    // that fit under limit=2. tx-A/B/C are skipped (already done); tx-D and
    // tx-E are newly queued. The classifier is called exactly 2 times.
    expect(summary.skipped).toBe(3);
    expect(summary.queued).toBe(2);
    expect(classifyMock).toHaveBeenCalledTimes(2);
    const queuedIds = summary.items
      .filter((i) => i.outcome === "queued_for_review")
      .map((i) => i.transaction_id)
      .sort();
    expect(queuedIds).toEqual(["tx-D", "tx-E"]);
  });

  it("retries rows that previously errored", async () => {
    await db.insert(processedTransactions).values({
      id: "tx-err",
      outcome: "error",
      error: "boom",
    });

    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-err" })]));
    readEnum.mockResolvedValueOnce(["X"]);
    classifyMock.mockResolvedValueOnce({
      output: { category: "X", reasoning: "x" },
      callId: 7,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      target: TARGET,
    });
    expect(summary.queued).toBe(1);
  });

  it("applies a matching rule and records matched_rule outcome", async () => {
    await db.insert(rules).values({
      domain: TRIAGE_DOMAIN,
      name: "rule-foo",
      match: { op: "equals", field: "full_description", value: "FOO MERCHANT" } as never,
      action: { category: "X", reasoning: "auto" } as never,
      priority: 100,
      enabled: true,
      createdBy: "test",
    });
    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-1" })]));
    readEnum.mockResolvedValueOnce(["X"]);
    applyMock.mockResolvedValueOnce({
      transactionId: "tx-1",
      rowIndex: 0,
      category: "X",
      changed: true,
    });

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      target: TARGET,
    });
    expect(summary.matched).toBe(1);
    expect(applyMock).toHaveBeenCalledOnce();
    const processed = await db
      .select()
      .from(processedTransactions)
      .where(eq(processedTransactions.id, "tx-1"));
    expect(processed[0].outcome).toBe("matched_rule");

    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("queues unmatched rows for review and records the AI call id", async () => {
    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-q" })]));
    readEnum.mockResolvedValueOnce(["Groceries", "Dining"]);
    classifyMock.mockResolvedValueOnce({
      output: { category: "Dining", reasoning: "merchant looks like dining" },
      callId: 123,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      target: TARGET,
    });
    expect(summary.queued).toBe(1);

    const review = await db
      .select()
      .from(needsReview)
      .where(eq(needsReview.subjectId, "tx-q"));
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({
      domain: TRIAGE_DOMAIN,
      subjectKind: "transaction",
      status: "pending",
      aiCallId: 123,
    });
    expect(review[0].proposedAction).toEqual({
      category: "Dining",
      reasoning: "merchant looks like dining",
    });

    const processed = await db
      .select()
      .from(processedTransactions)
      .where(eq(processedTransactions.id, "tx-q"));
    expect(processed[0]).toMatchObject({ outcome: "needs_review", outcomeId: review[0].id });
  });

  it("does not write to DB in dry-run mode", async () => {
    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-dry" })]));
    readEnum.mockResolvedValueOnce(["X"]);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      dryRun: true,
      target: TARGET,
    });
    expect(summary.queued).toBe(1);
    expect(summary.items[0].outcome).toBe("would_queue");

    expect(await db.select().from(needsReview)).toEqual([]);
    expect(await db.select().from(processedTransactions)).toEqual([]);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it("dry-run with rule match reports would_match without applying or recording", async () => {
    await db.insert(rules).values({
      domain: TRIAGE_DOMAIN,
      name: "r",
      match: { op: "equals", field: "transaction_id", value: "tx-dry" } as never,
      action: { category: "X", reasoning: "auto" } as never,
      priority: 100,
      enabled: true,
      createdBy: "test",
    });
    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-dry" })]));
    readEnum.mockResolvedValueOnce(["X"]);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      dryRun: true,
      target: TARGET,
    });
    expect(summary.matched).toBe(1);
    expect(summary.items[0].outcome).toBe("would_match");
    expect(applyMock).not.toHaveBeenCalled();
    expect(await db.select().from(processedTransactions)).toEqual([]);
  });

  it("records error outcome when classify rejects schema", async () => {
    readSheet.mockResolvedValueOnce(makeTab([makeRow({ transactionId: "tx-bad" })]));
    readEnum.mockResolvedValueOnce(["X"]);
    classifyMock.mockRejectedValueOnce(new ClassificationParseError("c", 55, "bad output"));

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "test",
      target: TARGET,
    });
    expect(summary.errors).toBe(1);
    const processed = await db
      .select()
      .from(processedTransactions)
      .where(eq(processedTransactions.id, "tx-bad"));
    expect(processed[0].outcome).toBe("error");
    expect(processed[0].error).toMatch(/ai_call 55/);
  });

  it("aborts the whole run on MissingAnthropicKeyError instead of grinding rows", async () => {
    readSheet.mockResolvedValueOnce(
      makeTab([
        makeRow({ transactionId: "tx-1" }),
        makeRow({ transactionId: "tx-2" }),
        makeRow({ transactionId: "tx-3" }),
      ]),
    );
    readEnum.mockResolvedValueOnce(["X"]);
    classifyMock.mockRejectedValue(new MissingAnthropicKeyError());

    await expect(
      triageTransactions({} as never, {
        limit: 10,
        sessionId: "test",
        target: TARGET,
      }),
    ).rejects.toBeInstanceOf(MissingAnthropicKeyError);

    // Only the first row should have hit classify before the error bubbled.
    expect(classifyMock).toHaveBeenCalledOnce();
    // No needs_review entries should have been written for any row.
    expect(await db.select().from(needsReview)).toEqual([]);
    // No processed_transactions error rows either — the error is a
    // configuration problem, not a per-row failure.
    expect(await db.select().from(processedTransactions)).toEqual([]);
  });
});

describe("registerTransactionApplier", () => {
  beforeEach(() => {
    clearAppliers();
    applyMock.mockReset();
  });

  it("registers an applier under subjectKind=transaction", () => {
    registerTransactionApplier({} as never, TARGET);
    expect(reviewAppliers.has("transaction")).toBe(true);
  });

  it("the applier passes the decision to applyTransactionCategory with ai:approved", async () => {
    registerTransactionApplier({} as never, TARGET);
    applyMock.mockResolvedValueOnce({
      transactionId: "tx-x",
      rowIndex: 0,
      category: "Groceries",
      changed: true,
    });
    await reviewAppliers.apply(
      "transaction",
      "tx-x",
      { category: "Groceries", reasoning: "ok" },
      { sessionId: "s", caller: "c", intent: "i" },
    );
    expect(applyMock).toHaveBeenCalledOnce();
    const [, , input, meta] = applyMock.mock.calls[0];
    expect(input).toEqual({
      transactionId: "tx-x",
      category: "Groceries",
      categorizedBy: "ai:approved",
    });
    expect(meta).toMatchObject({ sessionId: "s", caller: "c", intent: "i" });
  });
});

const SITUATIONAL_MATCH = {
  any: [
    { op: "contains", field: "description", value: "amazon" },
    { op: "contains", field: "full_description", value: "amazon" },
  ],
};

describe("triageTransactions — situational merchants", () => {
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
    readSheet.mockReset();
    readEnum.mockReset();
    classifyMock.mockReset();
    applyMock.mockReset();
  });

  it("sends a situational-merchant transaction to AI review instead of matching a rule", async () => {
    await db.insert(rules).values({
      domain: TRIAGE_DOMAIN,
      name: "situational: amazon",
      match: SITUATIONAL_MATCH as never,
      action: { situational: true } as never,
      priority: 10,
      enabled: true,
      createdBy: "situational",
    });
    readSheet.mockResolvedValueOnce(
      makeTab([makeRow({ transactionId: "tx-sit", description: "Amazon Order" })]),
    );
    readEnum.mockResolvedValueOnce(["Groceries", "Shopping"]);
    classifyMock.mockResolvedValueOnce({
      output: { category: "Shopping", reasoning: "amazon" },
      callId: 7,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never);

    const summary = await triageTransactions({} as never, {
      limit: 10,
      sessionId: "t",
      target: TARGET,
    });

    expect(summary.queued).toBe(1);
    expect(summary.matched).toBe(0);
    expect(applyMock).not.toHaveBeenCalled();
    expect(classifyMock).toHaveBeenCalledOnce();
  });
});

describe("applyRuleToSheet", () => {
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
    applyMock.mockReset();
  });

  it("categorizes uncategorized matching rows and leaves the rest untouched", async () => {
    readSheet.mockResolvedValueOnce(
      makeTab([
        makeRow({ transactionId: "u1", description: "Amazon", category: "" }),
        makeRow({ transactionId: "u2", description: "Amazon Mktp", category: "" }),
        makeRow({ transactionId: "c1", description: "Amazon", category: "Shopping" }),
        makeRow({ transactionId: "x1", description: "Costco", category: "" }),
      ]),
    );
    const rule = { id: 42, match: SITUATIONAL_MATCH, action: { category: "Shopping" } };
    const res = await applyRuleToSheet({} as never, TARGET, rule, {
      sessionId: "s",
      caller: "test",
    });
    expect(res.applied).toBe(2);
    expect(res.errors).toBe(0);
    expect(applyMock).toHaveBeenCalledTimes(2);
  });

  it("applies nothing for a situational marker rule (no category)", async () => {
    readSheet.mockResolvedValueOnce(
      makeTab([makeRow({ transactionId: "u1", description: "Amazon", category: "" })]),
    );
    const res = await applyRuleToSheet({} as never, TARGET, {
      id: 1,
      match: SITUATIONAL_MATCH,
      action: { situational: true },
    }, { sessionId: "s", caller: "test" });
    expect(res.applied).toBe(0);
    expect(applyMock).not.toHaveBeenCalled();
  });
});
