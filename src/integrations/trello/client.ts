import type { TrelloAuth } from "./auth.js";

const TRELLO_API_BASE = "https://api.trello.com/1";

export type TrelloLabel = {
  id: string;
  name: string;
  color: string | null;
};

export type TrelloList = {
  id: string;
  name: string;
  closed: boolean;
  idBoard: string;
  pos: number;
};

export type TrelloBoard = {
  id: string;
  name: string;
  closed: boolean;
};

export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idBoard: string;
  pos: number;
  due: string | null;
  dueComplete: boolean;
  closed: boolean;
  labels: TrelloLabel[];
  idLabels: string[];
  shortUrl?: string;
  dateLastActivity?: string;
};

export class TrelloApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`trello ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "TrelloApiError";
  }
}

function buildUrl(auth: TrelloAuth, path: string, params: Record<string, string | undefined> = {}): string {
  const url = new URL(`${TRELLO_API_BASE}${path}`);
  url.searchParams.set("key", auth.apiKey);
  url.searchParams.set("token", auth.token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function trelloFetch<T>(
  auth: TrelloAuth,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const res = await fetch(buildUrl(auth, path, params), { method });
  const text = await res.text();
  if (!res.ok) throw new TrelloApiError(res.status, path, text);
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TrelloApiError(res.status, path, `non-json body: ${text.slice(0, 200)}`);
  }
}

export type TrelloClient = {
  getBoard(boardId: string): Promise<TrelloBoard>;
  getLists(boardId: string): Promise<TrelloList[]>;
  getLabels(boardId: string): Promise<TrelloLabel[]>;
  listCards(listId: string): Promise<TrelloCard[]>;
  getCard(cardId: string): Promise<TrelloCard>;
  moveCard(cardId: string, opts: { idList?: string; pos?: number | "top" | "bottom" }): Promise<TrelloCard>;
  listMemberBoards(): Promise<TrelloBoard[]>;
};

export function makeTrelloClient(auth: TrelloAuth): TrelloClient {
  return {
    getBoard: (boardId) => trelloFetch<TrelloBoard>(auth, "GET", `/boards/${boardId}`),
    getLists: (boardId) =>
      trelloFetch<TrelloList[]>(auth, "GET", `/boards/${boardId}/lists`, { filter: "open" }),
    getLabels: (boardId) => trelloFetch<TrelloLabel[]>(auth, "GET", `/boards/${boardId}/labels`),
    listCards: (listId) =>
      trelloFetch<TrelloCard[]>(auth, "GET", `/lists/${listId}/cards`, {
        fields: "name,desc,idList,idBoard,pos,due,dueComplete,closed,idLabels,shortUrl,dateLastActivity",
      }),
    getCard: (cardId) => trelloFetch<TrelloCard>(auth, "GET", `/cards/${cardId}`),
    moveCard: (cardId, opts) => {
      const params: Record<string, string> = {};
      if (opts.idList) params.idList = opts.idList;
      if (opts.pos !== undefined) params.pos = String(opts.pos);
      return trelloFetch<TrelloCard>(auth, "PUT", `/cards/${cardId}`, params);
    },
    listMemberBoards: () =>
      trelloFetch<TrelloBoard[]>(auth, "GET", `/members/me/boards`, {
        filter: "open",
        fields: "name,closed",
      }),
  };
}
