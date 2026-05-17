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
      "email",
      "msg1",
      { foo: 1 },
      { sessionId: "s", caller: "test" },
      registry,
    );
    expect(out).toEqual({ applied: false, apply_error: "no applier registered for 'email'" });
  });

  it("returns applied=true with the applier's result on success", async () => {
    const registry = new ApplierRegistry();
    registry.register("email", async (subjectId, decision, meta) => ({
      subjectId,
      decision,
      caller: meta.caller,
    }));
    const out = await tryApply(
      "email",
      "msg1",
      { action: "archive" },
      { sessionId: "s", caller: "test:caller", intent: "i" },
      registry,
    );
    expect(out).toEqual({
      applied: true,
      apply_result: { subjectId: "msg1", decision: { action: "archive" }, caller: "test:caller" },
    });
  });

  it("captures applier errors as apply_error", async () => {
    const registry = new ApplierRegistry();
    registry.register("email", async () => {
      throw new Error("gmail says no");
    });
    const out = await tryApply(
      "email",
      "msg1",
      { foo: 1 },
      { sessionId: "s", caller: "test" },
      registry,
    );
    expect(out.applied).toBe(false);
    expect(out.apply_error).toBe("gmail says no");
  });

  it("stringifies non-Error throws", async () => {
    const registry = new ApplierRegistry();
    registry.register("email", async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "boom";
    });
    const out = await tryApply(
      "email",
      "msg1",
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

  function emailMatch(account: string, from: string) {
    return {
      all: [
        { op: "equals", field: "account", value: account },
        { op: "equals", field: "from", value: from },
      ],
    };
  }

  async function insertEmailReview(opts: {
    account: string;
    from: string;
    category?: string;
  }): Promise<number> {
    seq += 1;
    const [row] = await db
      .insert(needsReview)
      .values({
        domain: "email",
        subject: {
          account: opts.account,
          from: opts.from,
          subject: "hi",
          snippet: "",
          labels: [],
          to: null,
          received_at: null,
        } as never,
        subjectKind: "email",
        subjectId: `msg-${seq}`,
        proposedAction: { category: opts.category ?? "noise", reasoning: "ai" } as never,
        status: "pending",
      })
      .returning({ id: needsReview.id });
    return row.id;
  }

  function recordingRegistry(): { registry: ApplierRegistry; applied: string[] } {
    const applied: string[] = [];
    const registry = new ApplierRegistry();
    registry.register("email", async (subjectId) => {
      applied.push(subjectId);
      return "ok";
    });
    return { registry, applied };
  }

  it("reuses the existing rule instead of creating a duplicate for the same sender", async () => {
    const { registry } = recordingRegistry();
    const match = emailMatch("a@gmail.com", "noise@x.com");

    const id1 = await insertEmailReview({ account: "a@gmail.com", from: "noise@x.com" });
    const r1 = await approveEntry(
      id1,
      { promoteToRule: { name: "auto", match }, sessionId: "s", caller: "test" },
      { registry },
    );
    // Insert the second review only after the first is decided so auto-resolve
    // doesn't sweep it — this isolates the idempotent-promotion path.
    const id2 = await insertEmailReview({ account: "a@gmail.com", from: "noise@x.com" });
    const r2 = await approveEntry(
      id2,
      { promoteToRule: { name: "auto", match }, sessionId: "s", caller: "test" },
      { registry },
    );

    expect(r1.promotedRuleId).not.toBeNull();
    expect(r2.promotedRuleId).toBe(r1.promotedRuleId);
    const ruleRows = await db.select().from(rules);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0].action).toMatchObject({ category: "noise" });
  });

  it("updates the existing rule's category when a later correction differs (newest wins)", async () => {
    const { registry } = recordingRegistry();
    const match = emailMatch("a@gmail.com", "person@x.com");

    const id1 = await insertEmailReview({ account: "a@gmail.com", from: "person@x.com" });
    await correctEntry(
      id1,
      {
        decision: { category: "needs_reply", reasoning: "corrected" },
        promoteToRule: { name: "auto", match },
        sessionId: "s",
        caller: "test",
      },
      { registry },
    );
    const id2 = await insertEmailReview({ account: "a@gmail.com", from: "person@x.com" });
    await correctEntry(
      id2,
      {
        decision: { category: "noise", reasoning: "corrected again" },
        promoteToRule: { name: "auto", match },
        sessionId: "s",
        caller: "test",
      },
      { registry },
    );

    const ruleRows = await db.select().from(rules);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0].action).toMatchObject({ category: "noise" });
  });

  it("does not promote a rule for an unsafe (present) match — entry is still decided", async () => {
    const { registry } = recordingRegistry();
    const id = await insertEmailReview({ account: "a@gmail.com", from: "x@y.com" });
    const result = await approveEntry(
      id,
      {
        promoteToRule: { name: "auto", match: { op: "present", field: "from" } },
        sessionId: "s",
        caller: "test",
      },
      { registry },
    );
    expect(result.promotedRuleId).toBeNull();
    expect(result.entry.status).toBe("approved");
    expect(await db.select().from(rules)).toHaveLength(0);
  });

  it("auto-resolves other pending reviews from the same sender when a rule is created", async () => {
    const { registry, applied } = recordingRegistry();
    const match = emailMatch("a@gmail.com", "bulk@x.com");

    const idA = await insertEmailReview({ account: "a@gmail.com", from: "bulk@x.com" });
    const idB = await insertEmailReview({ account: "a@gmail.com", from: "bulk@x.com" });
    // A different sender must NOT be swept.
    const idOther = await insertEmailReview({ account: "a@gmail.com", from: "other@x.com" });

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
