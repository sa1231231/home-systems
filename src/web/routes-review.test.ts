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
      domain: "email",
      subject: { from: "alice@example.com", subject: "hi" } as never,
      subjectKind: "email",
      subjectId: "msg-1",
      proposedAction: { category: "noise", reasoning: "spam" } as never,
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

  describe("approve (email domain)", () => {
    it("approves an entry, promotes a rule keyed on sender, and applies via the applier", async () => {
      const appliedDecisions: unknown[] = [];
      setApplier("email", async (subjectId, decision) => {
        appliedDecisions.push({ subjectId, decision });
      });
      const id = await insertReview();
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/approve`);
      expect(res.status).toBe(200);

      const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      expect(entry.status).toBe("approved");
      expect(entry.decision).toEqual({ category: "noise", reasoning: "spam" });

      const ruleRows = await db.select().from(rules);
      expect(ruleRows).toHaveLength(1);
      expect(ruleRows[0]).toMatchObject({
        domain: "email",
        name: "auto: from=alice@example.com",
        createdBy: "approval",
        createdFromReviewId: id,
      });

      expect(appliedDecisions).toHaveLength(1);
    });

    it("returns 409 if the entry is already decided", async () => {
      const id = await insertReview({ status: "approved" });
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/approve`);
      expect(res.status).toBe(409);
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

  describe("correct (email domain)", () => {
    it("validates the email category enum", async () => {
      const id = await insertReview();
      const res = await request(buildApp())
        .post(`/ui/needs-review/${id}/correct`)
        .type("form")
        .send({ category: "bogus" });
      expect(res.status).toBe(500); // Zod throw mapped to 500 in renderError
    });

    it("accepts a valid category, records the corrected decision, and promotes a rule with the new action", async () => {
      setApplier("email", async () => {});
      const id = await insertReview();
      const res = await request(buildApp())
        .post(`/ui/needs-review/${id}/correct`)
        .type("form")
        .send({ category: "needs_reply" });
      expect(res.status).toBe(200);
      const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      expect(entry.status).toBe("corrected");
      const decision = entry.decision as { category: string; reasoning: string };
      expect(decision.category).toBe("needs_reply");
      expect(decision.reasoning).toContain("noise"); // previous category
      const ruleRows = await db.select().from(rules);
      expect(ruleRows[0]).toMatchObject({ domain: "email", createdBy: "correction" });
      expect(ruleRows[0].action).toMatchObject({ category: "needs_reply" });
    });
  });

  describe("transaction domain", () => {
    it("approve promotes a rule keyed on full_description", async () => {
      setApplier("transaction", async () => {});
      const id = await insertReview({
        domain: "transaction",
        subject: { full_description: "AMAZON MERCHANT", transaction_id: "tx-1" } as never,
        subjectKind: "transaction",
        subjectId: "tx-1",
        proposedAction: { category: "Groceries", reasoning: "ok" } as never,
      });
      const res = await request(buildApp()).post(`/ui/needs-review/${id}/approve`);
      expect(res.status).toBe(200);
      const ruleRows = await db.select().from(rules);
      expect(ruleRows[0]).toMatchObject({
        domain: "transaction",
        name: "auto: AMAZON MERCHANT",
      });
      expect(ruleRows[0].match).toEqual({
        op: "equals",
        field: "full_description",
        value: "AMAZON MERCHANT",
      });
    });

    it("correct accepts an arbitrary non-empty category", async () => {
      setApplier("transaction", async () => {});
      const id = await insertReview({
        domain: "transaction",
        subject: { full_description: "AMAZON" } as never,
        subjectKind: "transaction",
        subjectId: "tx-1",
        proposedAction: { category: "Groceries", reasoning: "ok" } as never,
      });
      const res = await request(buildApp())
        .post(`/ui/needs-review/${id}/correct`)
        .type("form")
        .send({ category: "Shopping & Personal" });
      expect(res.status).toBe(200);
      const [entry] = await db.select().from(needsReview).where(eq(needsReview.id, id));
      expect((entry.decision as { category: string }).category).toBe("Shopping & Personal");
    });

    it("correct rejects an empty category", async () => {
      const id = await insertReview({
        domain: "transaction",
        subjectKind: "transaction",
        subjectId: "tx-1",
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
