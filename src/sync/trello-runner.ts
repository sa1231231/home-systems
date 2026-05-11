import type { TrelloClient, TrelloCard } from "../integrations/trello/client.js";
import type { TrelloCreds } from "../integrations/trello/auth.js";
import { applyMoveCard, applyReorderCard } from "./trello-actions.js";
import {
  findDueToday,
  planReorder,
  toLocalDate,
  type CardForOrdering,
  type ReorderContext,
  type UpdateOp,
} from "./trello-reorder.js";

export type TrelloReorderResult = {
  today: string;
  planned: number;
  moved: number;
  reordered: number;
  unchanged: number;
  errors: Array<{ cardId: string; error: string }>;
  ops: UpdateOp[];
};

export type RunOptions = {
  dryRun: boolean;
  sessionId: string;
  caller: string;
  now?: Date;
};

export function toCardForOrdering(c: TrelloCard): CardForOrdering {
  return {
    id: c.id,
    idList: c.idList,
    pos: c.pos,
    due: c.due,
    labels: (c.labels ?? []).map((l) => ({ name: l.name })),
  };
}

export async function runTrelloReorderOnce(
  client: TrelloClient,
  creds: TrelloCreds,
  opts: RunOptions,
): Promise<TrelloReorderResult> {
  const now = opts.now ?? new Date();
  const ctx: ReorderContext = {
    today: toLocalDate(now, creds.tz),
    tz: creds.tz,
    dailyLabel: creds.dailyLabel,
    weekdaysLabel: creds.weekdaysLabel,
    weekendsLabel: creds.weekendsLabel,
  };

  const [waitingRaw, todayRaw] = await Promise.all([
    client.listCards(creds.waitingListId),
    client.listCards(creds.todayListId),
  ]);

  const waiting = waitingRaw.map(toCardForOrdering);
  const todayCards = todayRaw.map(toCardForOrdering);
  const incoming = findDueToday(waiting, ctx);
  const ops = planReorder(todayCards, incoming, ctx, creds.todayListId);
  const unchanged = todayCards.length + incoming.length - ops.length;

  if (opts.dryRun) {
    return {
      today: ctx.today,
      planned: ops.length,
      moved: 0,
      reordered: 0,
      unchanged,
      errors: [],
      ops,
    };
  }

  let moved = 0;
  let reordered = 0;
  const errors: Array<{ cardId: string; error: string }> = [];
  for (const op of ops) {
    try {
      if (op.kind === "move") {
        await applyMoveCard(client, op, { sessionId: opts.sessionId, caller: opts.caller });
        moved++;
      } else {
        await applyReorderCard(client, op, { sessionId: opts.sessionId, caller: opts.caller });
        reordered++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ cardId: op.cardId, error: message });
    }
  }
  return { today: ctx.today, planned: ops.length, moved, reordered, unchanged, errors, ops };
}
