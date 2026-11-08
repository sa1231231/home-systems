import type { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.js";
import { rules } from "../db/schema.js";
import { TRIAGE_DOMAIN } from "./transaction-triage.js";
import {
  appendAutoCatRules,
  autoCatExistingKeys,
  autoCatRuleKey,
  dbRuleToAutoCat,
  readAutoCat,
  type AutoCatCandidate,
} from "./transaction-autocat.js";

export type AutoCatMigrateTarget = { sheetId: string; autoCatTab: string };

export type AutoCatMigrateResult = {
  appended: number;
  skippedExisting: number;
  skippedUnsupported: number;
  tabMissing: boolean;
};

/**
 * One-shot: append the app's DB transaction rules into Tiller's AutoCat tab,
 * deduped against what's already there. After this, AutoCat is the single rules
 * store. Idempotent — re-running appends only genuinely new rules. Returns
 * tabMissing=true when the AutoCat tab doesn't exist (caller surfaces guidance).
 */
export async function migrateDbRulesToAutoCat(
  client: OAuth2Client,
  target: AutoCatMigrateTarget,
  options: { database?: typeof defaultDb } = {},
): Promise<AutoCatMigrateResult> {
  const database = options.database ?? defaultDb;
  const tab = await readAutoCat(client, target.sheetId, target.autoCatTab);
  if (!tab) {
    return { appended: 0, skippedExisting: 0, skippedUnsupported: 0, tabMissing: true };
  }

  const dbRules = await database.select().from(rules).where(eq(rules.domain, TRIAGE_DOMAIN));
  const seen = autoCatExistingKeys(tab.raw);
  const toAppend: AutoCatCandidate[] = [];
  let skippedExisting = 0;
  let skippedUnsupported = 0;

  for (const r of dbRules) {
    const candidate = dbRuleToAutoCat(r.match, r.action);
    if (!candidate) {
      skippedUnsupported += 1;
      continue;
    }
    const key = autoCatRuleKey(candidate);
    if (seen.has(key)) {
      skippedExisting += 1;
      continue;
    }
    seen.add(key);
    toAppend.push(candidate);
  }

  const appended = await appendAutoCatRules(
    client,
    target.sheetId,
    target.autoCatTab,
    tab.headers,
    toAppend,
  );
  return { appended, skippedExisting, skippedUnsupported, tabMissing: false };
}
