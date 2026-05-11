import { withChangelog } from "../changelog/index.js";
import { registry } from "../changelog/reversers.js";
import type { ChangelogRow } from "../changelog/types.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";
import type { TrelloClient } from "../integrations/trello/client.js";
import type { UpdateOp } from "./trello-reorder.js";

export const TRELLO_MOVE_CARD_OP = "trello.move_card";
export const TRELLO_REORDER_CARD_OP = "trello.reorder_card";
export const TRELLO_TARGET_KIND = "trello_card";

export type ApplyMeta = {
  sessionId: string;
  caller: string;
  intent?: string;
};

export async function applyMoveCard(
  client: TrelloClient,
  op: UpdateOp,
  meta: ApplyMeta,
): Promise<void> {
  if (op.kind !== "move") {
    throw new Error(`applyMoveCard called with non-move op: ${op.kind}`);
  }
  await enforceConfiguredDailyLimit(TRELLO_MOVE_CARD_OP);
  await withChangelog(
    {
      caller: meta.caller,
      sessionId: meta.sessionId,
      operation: TRELLO_MOVE_CARD_OP,
      targetKind: TRELLO_TARGET_KIND,
      targetId: op.cardId,
      intent: meta.intent,
      before: { id_list: op.fromList, pos: op.fromPos },
      after: { id_list: op.toList, pos: op.toPos },
      externalTarget: `trello:card:${op.cardId}`,
    },
    async () => {
      await client.moveCard(op.cardId, { idList: op.toList, pos: op.toPos });
    },
  );
}

export async function applyReorderCard(
  client: TrelloClient,
  op: UpdateOp,
  meta: ApplyMeta,
): Promise<void> {
  if (op.kind !== "reorder") {
    throw new Error(`applyReorderCard called with non-reorder op: ${op.kind}`);
  }
  await enforceConfiguredDailyLimit(TRELLO_REORDER_CARD_OP);
  await withChangelog(
    {
      caller: meta.caller,
      sessionId: meta.sessionId,
      operation: TRELLO_REORDER_CARD_OP,
      targetKind: TRELLO_TARGET_KIND,
      targetId: op.cardId,
      intent: meta.intent,
      before: { id_list: op.fromList, pos: op.fromPos },
      after: { id_list: op.toList, pos: op.toPos },
      externalTarget: `trello:card:${op.cardId}`,
    },
    async () => {
      await client.moveCard(op.cardId, { pos: op.toPos });
    },
  );
}

function reverseFromEntry(entry: ChangelogRow): { idList: string; pos: number } {
  const before = entry.beforeState as { id_list?: string; pos?: number };
  if (typeof before.id_list !== "string" || typeof before.pos !== "number") {
    throw new Error(`changelog ${entry.id} missing before.id_list/pos for trello reversal`);
  }
  return { idList: before.id_list, pos: before.pos };
}

export function registerTrelloReversers(client: TrelloClient): void {
  registry.register(TRELLO_MOVE_CARD_OP, async (entry) => {
    if (entry.targetKind !== TRELLO_TARGET_KIND || !entry.targetId) {
      throw new Error(`unexpected target for ${TRELLO_MOVE_CARD_OP}: ${entry.targetKind}/${entry.targetId}`);
    }
    const { idList, pos } = reverseFromEntry(entry);
    await client.moveCard(entry.targetId, { idList, pos });
  });
  registry.register(TRELLO_REORDER_CARD_OP, async (entry) => {
    if (entry.targetKind !== TRELLO_TARGET_KIND || !entry.targetId) {
      throw new Error(`unexpected target for ${TRELLO_REORDER_CARD_OP}: ${entry.targetKind}/${entry.targetId}`);
    }
    const { pos } = reverseFromEntry(entry);
    await client.moveCard(entry.targetId, { pos });
  });
}
