import { describe, expect, it } from "vitest";
import { ApplierRegistry, NoApplierError } from "./appliers.js";

describe("ApplierRegistry", () => {
  it("registers and dispatches by subject kind", async () => {
    const reg = new ApplierRegistry();
    const calls: Array<{ id: string; decision: unknown }> = [];
    reg.register("email", async (subjectId, decision) => {
      calls.push({ id: subjectId, decision });
      return { ok: true };
    });
    expect(reg.has("email")).toBe(true);
    const result = await reg.apply("email", "msg1", { category: "noise" }, {
      sessionId: "s",
      caller: "test",
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ id: "msg1", decision: { category: "noise" } }]);
  });

  it("throws NoApplierError when subject kind has no applier", async () => {
    const reg = new ApplierRegistry();
    await expect(
      reg.apply("contact", "people/c1", {}, { sessionId: "s", caller: "test" }),
    ).rejects.toBeInstanceOf(NoApplierError);
  });

  it("rejects duplicate registration", () => {
    const reg = new ApplierRegistry();
    reg.register("email", async () => undefined);
    expect(() => reg.register("email", async () => undefined)).toThrow(/already registered/);
  });
});
