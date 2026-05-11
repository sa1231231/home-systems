import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "../../tests/helpers/test-db.js";
import {
  isCustomFieldChecked,
  runTrelloReorderOnce,
  toCardForOrdering,
} from "./trello-runner.js";
import type { TrelloCard, TrelloClient } from "../integrations/trello/client.js";
import type { TrelloCreds } from "../integrations/trello/auth.js";

function makeCreds(overrides: Partial<TrelloCreds> = {}): TrelloCreds {
  return {
    apiKey: "key",
    token: "tok",
    boardId: "board-1",
    waitingListId: "list-w",
    todayListId: "list-t",
    dailyFieldId: "fd",
    weekdaysFieldId: "fwd",
    weekendsFieldId: "fwe",
    tz: "America/New_York",
    ...overrides,
  };
}

function makeCard(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-1",
    name: "Card",
    desc: "",
    idList: "list-w",
    idBoard: "board-1",
    pos: 100,
    due: null,
    dueComplete: false,
    closed: false,
    labels: [],
    idLabels: [],
    customFieldItems: [],
    ...overrides,
  };
}

function makeFakeClient(opts: {
  waiting: TrelloCard[];
  today: TrelloCard[];
  moveCard?: ReturnType<typeof vi.fn>;
}): TrelloClient {
  return {
    listCards: vi.fn(async (listId: string) => {
      if (listId === "list-w") return opts.waiting;
      if (listId === "list-t") return opts.today;
      return [];
    }) as never,
    moveCard: opts.moveCard ?? (vi.fn(async () => ({}) as never) as never),
    getBoard: vi.fn() as never,
    getLists: vi.fn() as never,
    getLabels: vi.fn() as never,
    getCard: vi.fn() as never,
    listMemberBoards: vi.fn() as never,
  };
}

describe("isCustomFieldChecked", () => {
  it("returns false when fieldId is undefined", () => {
    expect(isCustomFieldChecked(makeCard(), undefined)).toBe(false);
  });
  it("returns false when the card has no customFieldItems for that field", () => {
    expect(isCustomFieldChecked(makeCard(), "missing-field")).toBe(false);
  });
  it("returns true only when value.checked === 'true'", () => {
    const card = makeCard({
      customFieldItems: [
        { id: "i1", idCustomField: "fd", value: { checked: "true" } },
        { id: "i2", idCustomField: "fwd", value: { checked: "false" } },
        { id: "i3", idCustomField: "fwe", value: null },
      ],
    });
    expect(isCustomFieldChecked(card, "fd")).toBe(true);
    expect(isCustomFieldChecked(card, "fwd")).toBe(false);
    expect(isCustomFieldChecked(card, "fwe")).toBe(false);
  });
});

describe("toCardForOrdering", () => {
  it("derives recurrence flags from custom-field state", () => {
    const card = makeCard({
      customFieldItems: [
        { id: "i1", idCustomField: "fd", value: { checked: "true" } },
        { id: "i2", idCustomField: "fwd", value: { checked: "false" } },
      ],
    });
    const ord = toCardForOrdering(card, { daily: "fd", weekdays: "fwd", weekends: "fwe" });
    expect(ord).toMatchObject({
      id: "card-1",
      idList: "list-w",
      pos: 100,
      due: null,
      flags: { daily: true, weekdays: false, weekends: false },
    });
  });
});

describe("runTrelloReorderOnce", () => {
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

  it("dryRun returns planned ops without calling moveCard", async () => {
    const incoming = makeCard({
      id: "due-1",
      idList: "list-w",
      due: "2026-05-11T10:00:00Z",
      pos: 100,
    });
    const moveCard = vi.fn();
    const client = makeFakeClient({ waiting: [incoming], today: [], moveCard });
    const result = await runTrelloReorderOnce(client, makeCreds(), {
      dryRun: true,
      sessionId: "s",
      caller: "c",
      now: new Date("2026-05-11T15:00:00Z"),
    });
    expect(result.planned).toBeGreaterThan(0);
    expect(result.moved).toBe(0);
    expect(result.reordered).toBe(0);
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("non-dry run executes moves + reorders and reports counts", async () => {
    const incoming = makeCard({
      id: "due-1",
      idList: "list-w",
      due: "2026-05-11T10:00:00Z",
      pos: 100,
    });
    const moveCard = vi.fn(async () => ({}) as never);
    const client = makeFakeClient({ waiting: [incoming], today: [], moveCard });
    const result = await runTrelloReorderOnce(client, makeCreds(), {
      dryRun: false,
      sessionId: "s",
      caller: "c",
      now: new Date("2026-05-11T15:00:00Z"),
    });
    expect(result.moved + result.reordered).toBe(result.planned);
    expect(moveCard).toHaveBeenCalled();
  });

  it("captures per-op errors without aborting the run", async () => {
    const c1 = makeCard({ id: "card-A", idList: "list-w", due: "2026-05-11T10:00:00Z" });
    const c2 = makeCard({ id: "card-B", idList: "list-w", due: "2026-05-11T11:00:00Z" });
    const moveCard = vi
      .fn()
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("trello 429"));
    const client = makeFakeClient({ waiting: [c1, c2], today: [], moveCard });
    const result = await runTrelloReorderOnce(client, makeCreds(), {
      dryRun: false,
      sessionId: "s",
      caller: "c",
      now: new Date("2026-05-11T15:00:00Z"),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/trello 429/);
  });
});
