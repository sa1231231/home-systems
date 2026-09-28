import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { clearAppliers, setApplier } from "../../tests/helpers/registry.js";
import { db } from "../db/client.js";
import { needsReview, rules } from "../db/schema.js";
import { makeReviewUiRouter } from "./routes-review.js";

function buildApp() {
  const app = makeTestApp();
  mountViews(app);
  app.use("/ui/needs-review", makeReviewUiRouter());
  return app;
}

async function insertReview(overrides: Partial<typeof needsReview.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(needsReview)
    .values({
      domain: "transaction",
      subject: { full_description: "AMAZON MERCHANT", transaction_id: "tx-1" } as never,
      subjectKind: "transaction",
      subjectId: "tx-1",
      proposedAction: { category: "Groceries", reasoning: "ai" } as never,
      status: "pending",
      ...overrides,
    })
    .returning({ id: needsReview.id });
  return row.id;
}

describe("routes-review", () => {
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
  });

  describe("validation", () => {
    it("approve returns 400 on a non-numeric id", async () => {
      const res = await request(buildApp()).post("/ui/needs-review/abc/approve");
      expect(res.status).toBe(400);
    });
    it("approve returns 404 when the entry doesn't exist", async () => {
      const res = await request(buildApp()).post("/ui/needs-review/999/approve");
      expect(res.status).toBe(404);
    });
  });

  describe("approve", () => {
    it("approves an entry, promotes a rule keyed on full_description, and applies via the applier", async () => {
      const appliedDecisions: unknown[] = [];
      setApplier("transaction", async (subjectId, decision) => {
        appliedDecisions.push({ subjectId, decision });
      });
      const id = await insertReview();
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/approve`);
      expect(res.status).toBe(200);

      const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      expect(entry.status).toBe("approved");
      expect(entry.decision).toEqual({ category: "Groceries", reasoning: "ai" });

      const ruleRows = await db.select().from(rules);
      expect(ruleRows).toHaveLength(1);
      expect(ruleRows[0]).toMatchObject({
        domain: "transaction",
        name: "auto: AMAZON MERCHANT",
        createdBy: "approval",
        createdFromReviewId: id,
      });
      expect(ruleRows[0].match).toEqual({
        op: "equals",
        field: "full_description",
        value: "AMAZON MERCHANT",
      });

      expect(appliedDecisions).toHaveLength(1);
    });

    it("returns 409 if the entry is already decided", async () => {
      const id = await insertReview({ status: "approved" });
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/approve`);
      expect(res.status).toBe(409);
    });

    it("approving two reviews for the same merchant creates only one rule", async () => {
      setApplier("transaction", async () => {});
      const app = buildApp();
      const id1 = await insertReview();
      expect((await request(app).post(`/ui/needs-review/${id1}/approve`)).status).toBe(200);
      // Second review for the same merchant, inserted after the first is decided.
      const id2 = await insertReview({ subjectId: "tx-2" });
      expect((await request(app).post(`/ui/needs-review/${id2}/approve`)).status).toBe(200);

      const ruleRows = await db.select().from(rules);
      expect(ruleRows).toHaveLength(1);
    });
  });

  describe("reject", () => {
    it("marks the entry rejected and applies no action", async () => {
      const id = await insertReview();
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/reject`);
      expect(res.status).toBe(200);
      const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      expect(entry.status).toBe("rejected");
      const ruleRows = await db.select().from(rules);
      expect(ruleRows).toEqual([]);
    });
  });

  describe("correct", () => {
    it("accepts an arbitrary non-empty category", async () => {
      setApplier("transaction", async () => {});
      const id = await insertReview();
      const res = await request(buildApp())
        .post(`/ui/needs-review/${id}/correct`)
        .type("form")
        .send({ category: "Shopping & Personal" });
      expect(res.status).toBe(200);
      const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      expect(entry.status).toBe("corrected");
      expect((entry.decision as { category: string }).category).toBe("Shopping & Personal");
      const ruleRows = await db.select().from(rules);
      expect(ruleRows[0]).toMatchObject({ domain: "transaction", createdBy: "correction" });
      expect(ruleRows[0].action).toMatchObject({ category: "Shopping & Personal" });
    });

    it("rejects an empty category", async () => {
      const id = await insertReview({
        proposedAction: { category: "Groceries", reasoning: "" } as never,
      });
      const res = await request(buildApp())
        .post(`/ui/needs-review/${id}/correct`)
        .type("form")
        .send({ category: "" });
      expect(res.status).toBe(500); // Zod throw, mapped to 500
    });
  });

  describe("unknown domain", () => {
    it("approve returns 400 when no domain config is registered", async () => {
      const id = await insertReview({ domain: "unknown" });
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/approve`);
      expect(res.status).toBe(400);
    });
  });
});
