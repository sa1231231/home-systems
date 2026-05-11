import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTrelloClient, TrelloApiError, trelloGetRaw } from "./client.js";

const AUTH = { apiKey: "k", token: "t" };

function mockFetchOnce(opts: {
  ok?: boolean;
  status?: number;
  body?: string;
  jsonValue?: unknown;
  capture?: { url: string; method: string }[];
}): void {
  const body = opts.body ?? (opts.jsonValue !== undefined ? JSON.stringify(opts.jsonValue) : "");
  const ok = opts.ok ?? true;
  const status = opts.status ?? (ok ? 200 : 500);
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (opts.capture) {
      opts.capture.push({
        url: typeof url === "string" ? url : url.toString(),
        method: init?.method ?? "GET",
      });
    }
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trello client", () => {
  it("getBoard hits /boards/{id} with key+token", async () => {
    const captured: { url: string; method: string }[] = [];
    mockFetchOnce({
      jsonValue: { id: "b1", name: "Personal", closed: false },
      capture: captured,
    });
    const client = makeTrelloClient(AUTH);
    const board = await client.getBoard("b1");
    expect(board).toEqual({ id: "b1", name: "Personal", closed: false });
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toContain("/boards/b1");
    expect(captured[0].url).toContain("key=k");
    expect(captured[0].url).toContain("token=t");
  });

  it("getLists passes filter=open", async () => {
    const captured: { url: string; method: string }[] = [];
    mockFetchOnce({ jsonValue: [], capture: captured });
    await makeTrelloClient(AUTH).getLists("b1");
    expect(captured[0].url).toContain("filter=open");
  });

  it("listCards passes customFieldItems=true", async () => {
    const captured: { url: string; method: string }[] = [];
    mockFetchOnce({ jsonValue: [], capture: captured });
    await makeTrelloClient(AUTH).listCards("list1");
    expect(captured[0].url).toContain("/lists/list1/cards");
    expect(captured[0].url).toContain("customFieldItems=true");
  });

  it("moveCard issues a PUT with the provided opts", async () => {
    const captured: { url: string; method: string }[] = [];
    mockFetchOnce({ jsonValue: { id: "c1" }, capture: captured });
    await makeTrelloClient(AUTH).moveCard("c1", { idList: "L", pos: 100 });
    expect(captured[0].method).toBe("PUT");
    expect(captured[0].url).toContain("/cards/c1");
    expect(captured[0].url).toContain("idList=L");
    expect(captured[0].url).toContain("pos=100");
  });

  it("moveCard accepts top/bottom string positions", async () => {
    const captured: { url: string; method: string }[] = [];
    mockFetchOnce({ jsonValue: { id: "c1" }, capture: captured });
    await makeTrelloClient(AUTH).moveCard("c1", { pos: "top" });
    expect(captured[0].url).toContain("pos=top");
  });

  it("throws TrelloApiError on non-2xx response", async () => {
    mockFetchOnce({ ok: false, status: 429, body: "Too Many Requests" });
    const client = makeTrelloClient(AUTH);
    try {
      await client.getBoard("b1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TrelloApiError);
      expect((err as TrelloApiError).status).toBe(429);
      expect((err as TrelloApiError).path).toBe("/boards/b1");
    }
  });

  it("throws TrelloApiError on non-json 2xx response", async () => {
    mockFetchOnce({ ok: true, body: "<html>" });
    await expect(makeTrelloClient(AUTH).getBoard("b1")).rejects.toBeInstanceOf(TrelloApiError);
  });

  it("returns undefined for empty 2xx response", async () => {
    mockFetchOnce({ ok: true, body: "" });
    const res = await makeTrelloClient(AUTH).moveCard("c1", { pos: 1 });
    expect(res).toBeUndefined();
  });
});

describe("trelloGetRaw", () => {
  it("returns the parsed JSON body", async () => {
    mockFetchOnce({ jsonValue: { custom: true } });
    expect(await trelloGetRaw(AUTH, "/anything")).toEqual({ custom: true });
  });

  it("returns null on empty response", async () => {
    mockFetchOnce({ ok: true, body: "" });
    expect(await trelloGetRaw(AUTH, "/anything")).toBeNull();
  });

  it("throws TrelloApiError on non-2xx", async () => {
    mockFetchOnce({ ok: false, status: 401, body: "nope" });
    await expect(trelloGetRaw(AUTH, "/secret")).rejects.toBeInstanceOf(TrelloApiError);
  });
});
