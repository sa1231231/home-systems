import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { loadSnapshots, writeSnapshots } from "./contact-snapshots.js";

describe("contact-snapshots", () => {
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

  it("writes and loads snapshots round-trip", async () => {
    await writeSnapshots([
      { resourceName: "people/a", fields: { full_name: "A", company: "Acme" } },
      { resourceName: "people/b", fields: { full_name: "B", company: "" } },
    ]);
    const m = await loadSnapshots(["people/a", "people/b", "people/missing"]);
    expect(m.size).toBe(2);
    expect(m.get("people/a")).toEqual({ full_name: "A", company: "Acme" });
    expect(m.get("people/b")).toEqual({ full_name: "B", company: "" });
    expect(m.has("people/missing")).toBe(false);
  });

  it("upserts — a later write replaces the stored fields", async () => {
    await writeSnapshots([{ resourceName: "people/a", fields: { full_name: "Old" } }]);
    await writeSnapshots([{ resourceName: "people/a", fields: { full_name: "New" } }]);
    const m = await loadSnapshots(["people/a"]);
    expect(m.get("people/a")).toEqual({ full_name: "New" });
  });

  it("loadSnapshots returns an empty map for empty input", async () => {
    expect((await loadSnapshots([])).size).toBe(0);
  });

  it("writeSnapshots is a no-op for empty input", async () => {
    await writeSnapshots([]);
    expect((await loadSnapshots(["people/a"])).size).toBe(0);
  });
});
