/**
 * One-shot: insert two business-card rules and re-evaluate every pending
 * transaction review against current rules, applying matches so their
 * Category gets written back to the sheet.
 *
 * Run from a workstation with Railway env vars:
 *   railway run --service home-systems tsx scripts/seed-tx-rules-and-sweep.ts
 *
 * The script falls back to DATABASE_PUBLIC_URL when set, since DATABASE_URL
 * inside Railway is the internal *.railway.internal address which isn't
 * reachable from outside the cluster.
 */

import "dotenv/config";

// Prefer the public URL when running outside Railway's internal network.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { needsReview, rules } from "../src/db/schema.js";
import { getConfig } from "../src/config.js";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import { evaluate } from "../src/rules/engine.js";
import {
  registerTransactionApplier,
  TRIAGE_DOMAIN,
} from "../src/sync/transaction-triage.js";
import { correctEntry } from "../src/needs-review/service.js";
import { newSessionId } from "../src/changelog/index.js";

type RuleSpec = {
  name: string;
  match: Record<string, unknown>;
  action: { category: string; reasoning: string };
};

const RULES: RuleSpec[] = [
  {
    name: "Blue Business Cash (-1004) → ServiceCall Saver Expense",
    match: { op: "contains", field: "account", value: "(-1004)" },
    action: {
      category: "ServiceCall Saver Expense",
      reasoning: "amex 1004 = SCS business card",
    },
  },
  {
    name: "Blue Business Cash (-1008) → Underdog Productions Expense",
    match: { op: "contains", field: "account", value: "(-1008)" },
    action: {
      category: "Underdog Productions Expense",
      reasoning: "amex 1008 = Underdog business card",
    },
  },
];

async function ensureRules(): Promise<void> {
  for (const spec of RULES) {
    const existing = await db
      .select()
      .from(rules)
      .where(and(eq(rules.domain, TRIAGE_DOMAIN), eq(rules.name, spec.name)));
    if (existing.length > 0) {
      console.log(`  rule already exists: ${spec.name}`);
      continue;
    }
    await db.insert(rules).values({
      domain: TRIAGE_DOMAIN,
      name: spec.name,
      match: spec.match as never,
      action: spec.action as never,
      priority: 50, // beat the auto:* defaults (100) — these are user-confirmed mappings
      enabled: true,
      createdBy: "manual",
    });
    console.log(`  inserted rule: ${spec.name}`);
  }
}

async function sweepPending(): Promise<void> {
  const pending = await db
    .select()
    .from(needsReview)
    .where(and(eq(needsReview.domain, TRIAGE_DOMAIN), eq(needsReview.status, "pending")));
  console.log(`  scanning ${pending.length} pending transaction reviews…`);

  let matched = 0;
  let applied = 0;
  let failed = 0;
  const sessionId = `script:seed-and-sweep:${newSessionId()}`;
  for (const entry of pending) {
    const match = await evaluate(TRIAGE_DOMAIN, entry.subject);
    if (!match) continue;
    matched++;
    try {
      const result = await correctEntry(entry.id, {
        decision: match.action,
        decidedBy: "script:seed-and-sweep",
        sessionId,
        caller: "script:seed-and-sweep",
        intent: `swept by rule ${match.rule.id} (${match.rule.name})`,
      });
      if (result.apply.applied) {
        applied++;
        console.log(
          `  ✓ entry #${entry.id} → rule #${match.rule.id} (${match.rule.name})`,
        );
      } else {
        failed++;
        console.log(
          `  ✗ entry #${entry.id} matched rule #${match.rule.id} but applier failed: ${result.apply.apply_error}`,
        );
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ entry #${entry.id} matched but correctEntry threw: ${msg}`);
    }
  }
  console.log(`  done: matched=${matched} applied=${applied} failed=${failed}`);
}

async function main(): Promise<void> {
  console.log("seed-tx-rules-and-sweep starting");

  const config = getConfig();
  if (!config.TRANSACTIONS_SHEET_ID) {
    console.error("TRANSACTIONS_SHEET_ID is not set — aborting");
    process.exit(1);
  }
  console.log(`DATABASE_URL: ${config.DATABASE_URL.replace(/:\/\/[^@]+@/, "://***@")}`);
  console.log(`TRANSACTIONS_SHEET_ID: ${config.TRANSACTIONS_SHEET_ID}`);

  console.log("step 1: ensuring rules are present");
  await ensureRules();

  console.log("step 2: registering transaction applier (for sheet writes)");
  requireGoogleCreds();
  registerTransactionApplier(getOAuthClient(), {
    sheetId: config.TRANSACTIONS_SHEET_ID,
    transactionsTab: config.TRANSACTIONS_TAB,
    categoriesTab: config.CATEGORIES_TAB,
  });

  console.log("step 3: sweeping pending reviews against current rules");
  await sweepPending();

  await pool.end();
  console.log("done");
}

main().catch(async (err) => {
  console.error("FAILED:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
