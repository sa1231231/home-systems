import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { clearReversers } from "../../tests/helpers/registry.js";
import {
  applyMoveCard,
  applyReorderCard,
  registerTrelloReversers,
  TRELLO_MOVE_CARD_OP,
  TRELLO_REORDER_CARD_OP,
  TRELLO_TARGET_KIND,
} from "./trello-actions.js";
import { registry } from "../changelog/reversers.js";
import type { TrelloClient } from "../integrations/trello/client.js";
import type { UpdateOp } from "./trello-reorder.js";

function fakeClient(): {
  client: TrelloClient;
  moveCardMock: ReturnType<typeof vi.fn>;
} {
  const moveCardMock = vi.fn(async (_id: string, _opts: unknown) => ({}) as never);
  const client: TrelloClient = {
    getBoard: vi.fn() as never,
    getLists: vi.fn() as never,
    getLabels: vi.fn() as never,
    listCards: vi.fn() as never,
    getCard: vi.fn() as never,
    moveCard: moveCardMock as never,
    listMemberBoards: vi.fn() as never,
  };
  return { client, moveCardMock };
}

const META = { sessionId: "s", caller: "c", intent: "i" };

describe("trello-actions: applyMoveCard", () => {
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

  it("logs a changelog row and calls moveCard with idList + pos", async () => {
    const { client, moveCardMock } = fakeClient();
    const op: UpdateOp = {
      kind: "move",
      cardId: "card-1",
      fromList: "list-a",
      fromPos: 100,
      toList: "list-b",
      toPos: 50,
    };
    await applyMoveCard(client, op, META);
    expect(moveCardMock).toHaveBeenCalledWith("card-1", { idList: "list-b", pos: 50 });
    const [row] = await db.select().from(changelog);
    expect(row).toMatchObject({
      operation: TRELLO_MOVE_CARD_OP,
      targetKind: TRELLO_TARGET_KIND,
      targetId: "card-1",
      status: "success",
      externalTarget: "trello:card:card-1",
    });
    expect(row.beforeState).toEqual({ id_list: "list-a", pos: 100 });
    expect(row.afterState).toEqual({ id_list: "list-b", pos: 50 });
  });

  it("throws if called with a non-move op", async () => {
    const { client } = fakeClient();
    await expect(
      applyMoveCard(client, { kind: "reorder", cardId: "x", fromList: "a", fromPos: 1, toList: "a", toPos: 2 }, META),
    ).rejects.toThrow(/non-move/);
  });
});

describe("trello-actions: applyReorderCard", () => {
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

  it("calls moveCard with pos only and logs a reorder changelog", async () => {
    const { client, moveCardMock } = fakeClient();
    const op: UpdateOp = {
      kind: "reorder",
      cardId: "card-1",
      fromList: "list-a",
      fromPos: 100,
      toList: "list-a",
      toPos: 50,
    };
    await applyReorderCard(client, op, META);
    expect(moveCardMock).toHaveBeenCalledWith("card-1", { pos: 50 });
    const [row] = await db.select().from(changelog);
    expect(row).toMatchObject({ operation: TRELLO_REORDER_CARD_OP, status: "success" });
  });

  it("throws if called with a non-reorder op", async () => {
    const { client } = fakeClient();
    await expect(
      applyReorderCard(
        client,
        { kind: "move", cardId: "x", fromList: "a", fromPos: 1, toList: "b", toPos: 2 },
        META,
      ),
    ).rejects.toThrow(/non-reorder/);
  });
});

describe("registerTrelloReversers", () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.reset();
    clearReversers();
  });

  it("registers move + reorder reversers that call moveCard with before state", async () => {
    const { client, moveCardMock } = fakeClient();
    registerTrelloReversers(client);

    // simulate executing the move reverser via the registry
    await registry.reverse({
      id: 1,
      createdAt: new Date(),
      caller: "c",
      sessionId: "s",
      operation: TRELLO_MOVE_CARD_OP,
      targetKind: TRELLO_TARGET_KIND,
      targetId: "card-1",
      intent: null,
      beforeState: { id_list: "list-a", pos: 100 },
      afterState: { id_list: "list-b", pos: 50 },
      externalTarget: "trello:card:card-1",
      status: "success",
      error: null,
      undoneBy: null,
    });
    expect(moveCardMock).toHaveBeenCalledWith("card-1", { idList: "list-a", pos: 100 });

    moveCardMock.mockClear();
    await registry.reverse({
      id: 2,
      createdAt: new Date(),
      caller: "c",
      sessionId: "s",
      operation: TRELLO_REORDER_CARD_OP,
      targetKind: TRELLO_TARGET_KIND,
      targetId: "card-1",
      intent: null,
      beforeState: { id_list: "list-a", pos: 100 },
      afterState: { id_list: "list-a", pos: 50 },
      externalTarget: "trello:card:card-1",
      status: "success",
      error: null,
      undoneBy: null,
    });
    expect(moveCardMock).toHaveBeenCalledWith("card-1", { pos: 100 });
  });

  it("rejects changelog entries with missing before.id_list / pos", async () => {
    const { client } = fakeClient();
    registerTrelloReversers(client);
    await expect(
      registry.reverse({
        id: 1,
        createdAt: new Date(),
        caller: "c",
        sessionId: "s",
        operation: TRELLO_MOVE_CARD_OP,
        targetKind: TRELLO_TARGET_KIND,
        targetId: "card-1",
        intent: null,
        beforeState: {},
        afterState: {},
        externalTarget: null,
        status: "success",
        error: null,
        undoneBy: null,
      }),
    ).rejects.toThrow(/missing before.id_list/);
  });
});
