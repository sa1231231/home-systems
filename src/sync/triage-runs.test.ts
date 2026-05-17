import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { triageRuns } from "../db/schema.js";
import {
  completeRun,
  failRun,
  isRunning,
  latestRunFor,
  startRun,
  withTriageRun,
} from "./triage-runs.js";

describe("triage-runs", () => {
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

  describe("startRun", () => {
    it("inserts a row with status=running and returns the id", async () => {
      const id = await startRun("email", "session-a", "ui:gmail.triage");
      expect(id).toBeGreaterThan(0);
      const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, id));
      expect(row).toMatchObject({
        domain: "email",
        sessionId: "session-a",
        caller: "ui:gmail.triage",
        status: "running",
        summary: null,
        error: null,
        completedAt: null,
      });
      expect(row.startedAt).toBeInstanceOf(Date);
    });
  });

  describe("completeRun / failRun", () => {
    it("completeRun flips to success and stores summary", async () => {
      const id = await startRun("transaction", "s", "ui:t");
      await completeRun(id, { total: 5, matched: 2, queued: 1, skipped: 2, errors: 0 });
      const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, id));
      expect(row.status).toBe("success");
      expect(row.summary).toMatchObject({ total: 5, matched: 2 });
      expect(row.completedAt).toBeInstanceOf(Date);
      expect(row.error).toBeNull();
    });

    it("failRun flips to error and stores truncated error message", async () => {
      const id = await startRun("contact", "s", "ui:c");
      await failRun(id, new Error("x".repeat(5000)));
      const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, id));
      expect(row.status).toBe("error");
      expect(row.error?.length).toBe(4000);
      expect(row.completedAt).toBeInstanceOf(Date);
    });

    it("failRun stringifies non-Error values", async () => {
      const id = await startRun("trello", "s", "ui:t");
      await failRun(id, "stringly-thrown");
      const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, id));
      expect(row.error).toBe("stringly-thrown");
    });
  });

  describe("withTriageRun", () => {
    it("wraps a happy-path run, records summary, returns the inner value", async () => {
      const result = await withTriageRun("email", "s", "test:caller", async () => "done");
      expect(result).toBe("done");
      const [row] = await db.select().from(triageRuns);
      expect(row.status).toBe("success");
    });

    it("records failure and rethrows on inner error", async () => {
      await expect(
        withTriageRun("email", "s", "test:caller", async () => {
          throw new Error("inner died");
        }),
      ).rejects.toThrow("inner died");
      const [row] = await db.select().from(triageRuns);
      expect(row.status).toBe("error");
      expect(row.error).toBe("inner died");
    });

    it("writes the running row BEFORE the inner function executes", async () => {
      let observedRunning = false;
      await withTriageRun("email", "s", "test:caller", async () => {
        const [r] = await db.select().from(triageRuns);
        observedRunning = r?.status === "running";
      });
      expect(observedRunning).toBe(true);
    });
  });

  describe("latestRunFor / isRunning", () => {
    it("returns null when no recent run exists", async () => {
      expect(await latestRunFor("email")).toBeNull();
      expect(await isRunning("email")).toBe(false);
    });

    it("returns the most recent run for the requested domain only", async () => {
      const a = await startRun("email", "s1", "c1");
      await startRun("transaction", "s2", "c2");
      const b = await startRun("email", "s3", "c3");
      const latest = await latestRunFor("email");
      expect(latest?.id).toBe(b);
      expect(latest?.id).not.toBe(a);
    });

    it("isRunning is true only while status is 'running'", async () => {
      const id = await startRun("email", "s", "c");
      expect(await isRunning("email")).toBe(true);
      await completeRun(id, {});
      expect(await isRunning("email")).toBe(false);
    });

    it("respects the lookback window", async () => {
      const id = await startRun("email", "s", "c");
      // Manually backdate the row 2 hours so it falls outside default 1h window.
      await db
        .update(triageRuns)
        .set({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(triageRuns.id, id));
      expect(await latestRunFor("email")).toBeNull();
      expect(await latestRunFor("email", { lookbackMs: 4 * 60 * 60 * 1000 })).not.toBeNull();
    });

    it("self-heals a run stuck 'running' past the timeout to 'error'", async () => {
      const id = await startRun("contact", "s", "ui:contacts.sync");
      // Backdate 20 min — past the 15-min stuck threshold, inside the 1h window.
      await db
        .update(triageRuns)
        .set({ startedAt: new Date(Date.now() - 20 * 60 * 1000) })
        .where(eq(triageRuns.id, id));
      const latest = await latestRunFor("contact");
      expect(latest?.status).toBe("error");
      const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, id));
      expect(row.status).toBe("error");
      expect(row.completedAt).toBeInstanceOf(Date);
    });

    it("leaves a recent 'running' run untouched", async () => {
      await startRun("contact", "s", "ui:contacts.sync");
      const latest = await latestRunFor("contact");
      expect(latest?.status).toBe("running");
    });
  });
});
