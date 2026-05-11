import type { OAuth2Client } from "google-auth-library";
import { withChangelog } from "../changelog/index.js";
import { registry } from "../changelog/reversers.js";
import type { ChangelogRow } from "../changelog/types.js";
import { getMessageMetadata, modifyLabels } from "../integrations/google/gmail.js";
import { enforceConfiguredDailyLimit } from "../safety/limits.js";

export const EMAIL_MODIFY_OP = "email.modify_labels";

export type EmailAction = {
  add_labels: string[];
  remove_labels: string[];
  reasoning?: string;
};

export type ApplyMeta = {
  sessionId: string;
  caller: string;
  intent?: string;
};

export type ApplyResult = {
  gmail_id: string;
  before_labels: string[];
  after_labels: string[];
  changed: boolean;
};

/**
 * Compute the resulting label set after applying add/remove operations.
 * Adds happen after removes, idempotent on duplicates. Returns the new set
 * (sorted) and which labels were actually added or removed.
 */
export function planLabelChange(
  beforeLabels: string[],
  action: EmailAction,
): { afterLabels: string[]; added: string[]; removed: string[]; changed: boolean } {
  const beforeSet = new Set(beforeLabels);
  const result = new Set(beforeLabels);
  for (const l of action.remove_labels) result.delete(l);
  for (const l of action.add_labels) result.add(l);
  const afterLabels = [...result].sort();
  const added = afterLabels.filter((l) => !beforeSet.has(l));
  const removed = [...beforeSet].filter((l) => !result.has(l)).sort();
  return { afterLabels, added, removed, changed: added.length > 0 || removed.length > 0 };
}

export async function applyEmailAction(
  client: OAuth2Client,
  gmailId: string,
  action: EmailAction,
  meta: ApplyMeta,
): Promise<ApplyResult> {
  const message = await getMessageMetadata(client, gmailId);
  const before = [...message.labelIds].sort();
  const plan = planLabelChange(before, action);

  if (!plan.changed) {
    return { gmail_id: gmailId, before_labels: before, after_labels: before, changed: false };
  }

  await enforceConfiguredDailyLimit(EMAIL_MODIFY_OP);

  await withChangelog(
    {
      caller: meta.caller,
      sessionId: meta.sessionId,
      operation: EMAIL_MODIFY_OP,
      targetKind: "email",
      targetId: gmailId,
      intent: meta.intent,
      before: { labels: before, removed: plan.removed, added: plan.added, reasoning: action.reasoning ?? null },
      after: { labels: plan.afterLabels },
      externalTarget: `gmail:message:${gmailId}`,
    },
    async () => {
      await modifyLabels(client, gmailId, {
        addLabelIds: plan.added,
        removeLabelIds: plan.removed,
      });
    },
  );

  return { gmail_id: gmailId, before_labels: before, after_labels: plan.afterLabels, changed: true };
}

/** Reverse an email.modify_labels entry by swapping the add/remove sets. */
export function planEmailReversal(entry: ChangelogRow): {
  addLabelIds: string[];
  removeLabelIds: string[];
} {
  const before = entry.beforeState as { added?: string[]; removed?: string[] };
  const added = Array.isArray(before.added) ? before.added : [];
  const removed = Array.isArray(before.removed) ? before.removed : [];
  return { addLabelIds: removed, removeLabelIds: added };
}

export function registerEmailReverser(client: OAuth2Client): void {
  registry.register(EMAIL_MODIFY_OP, async (entry) => {
    const plan = planEmailReversal(entry);
    if (entry.targetKind !== "email" || !entry.targetId) {
      throw new Error(`unexpected target for ${EMAIL_MODIFY_OP}: ${entry.targetKind}/${entry.targetId}`);
    }
    await modifyLabels(client, entry.targetId, plan);
  });
}
