import { getConfig } from "../../config.js";

export type TrelloCreds = {
  apiKey: string;
  token: string;
  boardId: string;
  waitingListId: string;
  todayListId: string;
  dailyLabel: string;
  weekdaysLabel: string;
  weekendsLabel: string;
  tz: string;
};

export class MissingTrelloCredsError extends Error {
  constructor(missing: string[] = []) {
    const detail = missing.length > 0 ? `: missing ${missing.join(", ")}` : "";
    super(`trello credentials not configured${detail}`);
    this.name = "MissingTrelloCredsError";
  }
}

export function hasTrelloCreds(): boolean {
  const c = getConfig();
  return Boolean(
    c.TRELLO_API_KEY &&
      c.TRELLO_TOKEN &&
      c.TRELLO_BOARD_ID &&
      c.TRELLO_WAITING_LIST_ID &&
      c.TRELLO_TODAY_LIST_ID,
  );
}

export function requireTrelloCreds(): TrelloCreds {
  const c = getConfig();
  const missing: string[] = [];
  if (!c.TRELLO_API_KEY) missing.push("TRELLO_API_KEY");
  if (!c.TRELLO_TOKEN) missing.push("TRELLO_TOKEN");
  if (!c.TRELLO_BOARD_ID) missing.push("TRELLO_BOARD_ID");
  if (!c.TRELLO_WAITING_LIST_ID) missing.push("TRELLO_WAITING_LIST_ID");
  if (!c.TRELLO_TODAY_LIST_ID) missing.push("TRELLO_TODAY_LIST_ID");
  if (missing.length > 0) throw new MissingTrelloCredsError(missing);
  return {
    apiKey: c.TRELLO_API_KEY!,
    token: c.TRELLO_TOKEN!,
    boardId: c.TRELLO_BOARD_ID!,
    waitingListId: c.TRELLO_WAITING_LIST_ID!,
    todayListId: c.TRELLO_TODAY_LIST_ID!,
    dailyLabel: c.TRELLO_DAILY_LABEL,
    weekdaysLabel: c.TRELLO_WEEKDAYS_LABEL,
    weekendsLabel: c.TRELLO_WEEKENDS_LABEL,
    tz: c.TRELLO_TZ,
  };
}

/**
 * Auth values that only require the key+token, without specific board/list IDs.
 * Used by the setup script before the user knows which IDs to plug in.
 */
export type TrelloAuth = { apiKey: string; token: string };

export function requireTrelloAuth(): TrelloAuth {
  const c = getConfig();
  if (!c.TRELLO_API_KEY || !c.TRELLO_TOKEN) {
    throw new MissingTrelloCredsError(
      [!c.TRELLO_API_KEY && "TRELLO_API_KEY", !c.TRELLO_TOKEN && "TRELLO_TOKEN"].filter(
        (v): v is string => Boolean(v),
      ),
    );
  }
  return { apiKey: c.TRELLO_API_KEY, token: c.TRELLO_TOKEN };
}
