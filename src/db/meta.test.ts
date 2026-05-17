import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { deleteMeta, getMeta, setMeta } from "./meta.js";

describe("meta", () => {
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

  it("returns null for a missing key", async () => {
    expect(await getMeta("contacts.sync_token")).toBeNull();
  });

  it("sets and reads back a value", async () => {
    await setMeta("contacts.sync_token", "TOK1");
    expect(await getMeta("contacts.sync_token")).toBe("TOK1");
  });

  it("setMeta upserts an existing key", async () => {
    await setMeta("contacts.sync_token", "TOK1");
    await setMeta("contacts.sync_token", "TOK2");
    expect(await getMeta("contacts.sync_token")).toBe("TOK2");
  });

  it("deleteMeta removes the key", async () => {
    await setMeta("contacts.sync_token", "TOK1");
    await deleteMeta("contacts.sync_token");
    expect(await getMeta("contacts.sync_token")).toBeNull();
  });
});
