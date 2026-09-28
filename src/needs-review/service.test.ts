import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { ApplierRegistry } from "./appliers.js";
import { approveEntry, correctEntry, tryApply } from "./service.js";

describe("tryApply", () => {
  it("returns applied=false with no_applier message when no applier is registered", async () => {
    const registry = new ApplierRegistry();
    const out = await tryApply(
      "transaction",
      "tx1",
      { foo: 1 },
      { sessionId: "s", caller: "test" },
      registry,
    );
    expect(out).toEqual({ applied: false, apply_error: "no applier registered for 'transaction'" });
  });

  it("returns applied=true with the applier's result on success", async () => {
    const registry = new ApplierRegistry();
    registry.register("transaction", async (subjectId, decision, meta) => ({
      subjectId,
      decision,
      caller: meta.caller,
    }));
    const out = await tryApply(
      "transaction",
      "tx1",
      { action: "categorize" },
      { sessionId: "s", caller: "test:caller", intent: "i" },
      registry,
    );
    expect(out).toEqual({
      applied: true,
      apply_result: { subjectId: "tx1", decision: { action: "categorize" }, caller: "test:caller" },
    });
  });

  it("captures applier errors as apply_error", async () => {
    const registry = new ApplierRegistry();
    registry.register("transaction", async () => {
      throw new Error("applier says no");
    });
    const out = await tryApply(
      "transaction",
      "tx1",
      { foo: 1 },
      { sessionId: "s", caller: "test" },
      registry,
    );
    expect(out.applied).toBe(false);
    expect(out.apply_error).toBe("applier says no");
  });

  it("stringifies non-Error throws", async () => {
    const registry = new ApplierRegistry();
    registry.register("transaction", async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "boom";
    });
    const out = await tryApply(
      "transaction",
      "tx1",
      {},
      { sessionId: "s", caller: "test" },
      registry,
    );
    expect(out.applied).toBe(false);
    expect(out.apply_error).toBe("boom");
  });
});

describe("rule promotion (approve/correct)", () => {
  let handle: TestDbHandle;
  let seq = 0;

  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
  });

  function merchantMatch(fullDescription: string) {
    return { op: "equals", field: "full_description", value: fullDescription };
  }

  async function insertMerchantReview(opts: {
    fullDescription: string;
    category?: string;
  }): Promise<number> {
    seq += 1;
    const [row] = await db
      .insert(needsReview)
      .values({
        domain: "transaction",
        subject: {
          full_description: opts.fullDescription,
          description: opts.fullDescription,
          transaction_id: `tx-${seq}`,
        } as never,
        subjectKind: "transaction",
        subjectId: `tx-${seq}`,
        proposedAction: { category: opts.category ?? "Groceries", reasoning: "ai" } as never,
        status: "pending",
      })
      .returning({ id: needsReview.id });
    return row.id;
  }

  function recordingRegistry(): { registry: ApplierRegistry; applied: string[] } {
    const applied: string[] = [];
    const registry = new ApplierRegistry();
    registry.register("transaction", async (subjectId) => {
      applied.push(subjectId);
      return "ok";
    });
    return { registry, applied };
  }

  it("reuses the existing rule instead of creating a duplicate for the same merchant", async () => {
    const { registry } = recordingRegistry();
    const match = merchantMatch("AMAZON MERCHANT");

    const id1 = await insertMerchantReview({ fullDescription: "AMAZON MERCHANT" });
    const r1 = await approveEntry(
      id1,
      { promoteToRule: { name: "auto", match }, sessionId: "s", caller: "test" },
      { registry },
    );
    // Insert the second review only after the first is decided so auto-resolve
    // doesn't sweep it — this isolates the idempotent-promotion path.
    const id2 = await insertMerchantReview({ fullDescription: "AMAZON MERCHANT" });
    const r2 = await approveEntry(
      id2,
      { promoteToRule: { name: "auto", match }, sessionId: "s", caller: "test" },
      { registry },
    );

    expect(r1.promotedRuleId).not.toBeNull();
    expect(r2.promotedRuleId).toBe(r1.promotedRuleId);
    const ruleRows = await db.select().from(rules);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0].action).toMatchObject({ category: "Groceries" });
  });

  it("updates the existing rule's category when a later correction differs (newest wins)", async () => {
    const { registry } = recordingRegistry();
    const match = merchantMatch("COSTCO #11");

    const id1 = await insertMerchantReview({ fullDescription: "COSTCO #11" });
    await correctEntry(
      id1,
      {
        decision: { category: "Dining", reasoning: "corrected" },
        promoteToRule: { name: "auto", match },
        sessionId: "s",
        caller: "test",
      },
      { registry },
    );
    const id2 = await insertMerchantReview({ fullDescription: "COSTCO #11" });
    await correctEntry(
      id2,
      {
        decision: { category: "Groceries", reasoning: "corrected again" },
        promoteToRule: { name: "auto", match },
        sessionId: "s",
        caller: "test",
      },
      { registry },
    );

    const ruleRows = await db.select().from(rules);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0].action).toMatchObject({ category: "Groceries" });
  });

  it("does not promote a rule for an unsafe (present) match — entry is still decided", async () => {
    const { registry } = recordingRegistry();
    const id = await insertMerchantReview({ fullDescription: "SOME STORE" });
    const result = await approveEntry(
      id,
      {
        promoteToRule: { name: "auto", match: { op: "present", field: "full_description" } },
        sessionId: "s",
        caller: "test",
      },
      { registry },
    );
    expect(result.promotedRuleId).toBeNull();
    expect(result.entry.status).toBe("approved");
    expect(await db.select().from(rules)).toHaveLength(0);
  });

  it("auto-resolves other pending reviews from the same merchant when a rule is created", async () => {
    const { registry, applied } = recordingRegistry();
    const match = merchantMatch("BULK MART");

    const idA = await insertMerchantReview({ fullDescription: "BULK MART" });
    const idB = await insertMerchantReview({ fullDescription: "BULK MART" });
    // A different merchant must NOT be swept.
    const idOther = await insertMerchantReview({ fullDescription: "OTHER STORE" });

    await approveEntry(
      idA,
      { promoteToRule: { name: "auto", match }, sessionId: "s", caller: "test" },
      { registry },
    );

    const [b] = await db.select().from(needsReview).where(eq(needsReview.id, idB));
    expect(b.status).toBe("approved");
    expect(b.decidedBy).toMatch(/^auto:rule-/);
    const [other] = await db.select().from(needsReview).where(eq(needsReview.id, idOther));
    expect(other.status).toBe("pending");
    // The applier ran for both the approved entry and the auto-resolved sibling.
    expect(applied).toHaveLength(2);
    expect(await db.select().from(rules)).toHaveLength(1);
  });
});

describe("situational merchant guard", () => {
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

  const situationalMatch = {
    any: [
      { op: "contains", field: "description", value: "amazon" },
      { op: "contains", field: "full_description", value: "amazon" },
    ],
  };

  async function insertTransactionReview(subject: Record<string, unknown>): Promise<number> {
    const [row] = await db
      .insert(needsReview)
      .values({
        domain: "transaction",
        subject: subject as never,
        subjectKind: "transaction",
        subjectId: `tx-${Math.random().toString(36).slice(2, 8)}`,
        proposedAction: { category: "Shopping", reasoning: "ai" } as never,
        status: "pending",
      })
      .returning({ id: needsReview.id });
    return row.id;
  }

  it("does not promote a rule when a situational rule matches the subject", async () => {
    await db.insert(rules).values({
      domain: "transaction",
      name: "situational: amazon",
      match: situationalMatch as never,
      action: { situational: true } as never,
      priority: 10,
      createdBy: "situational",
    });
    const id = await insertTransactionReview({
      description: "Amazon Order",
      full_description: "AMZN MKTP",
    });
    const result = await approveEntry(
      id,
      {
        promoteToRule: {
          name: "auto",
          match: { op: "equals", field: "full_description", value: "AMZN MKTP" },
        },
        sessionId: "s",
        caller: "test",
      },
      { registry: new ApplierRegistry() },
    );
    expect(result.promotedRuleId).toBeNull();
    expect(result.entry.status).toBe("approved");
    // Only the situational marker rule — no category rule was created.
    const rs = await db.select().from(rules);
    expect(rs).toHaveLength(1);
    expect(rs[0].action).toEqual({ situational: true });
  });

  it("promotes a rule normally when no situational rule matches", async () => {
    const id = await insertTransactionReview({
      description: "Costco",
      full_description: "COSTCO #11",
    });
    const result = await approveEntry(
      id,
      {
        promoteToRule: {
          name: "auto",
          match: { op: "equals", field: "full_description", value: "COSTCO #11" },
        },
        sessionId: "s",
        caller: "test",
      },
      { registry: new ApplierRegistry() },
    );
    expect(result.promotedRuleId).not.toBeNull();
  });
});
