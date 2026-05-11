import { describe, expect, it } from "vitest";
import { ApplierRegistry } from "./appliers.js";
import { tryApply } from "./service.js";

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
