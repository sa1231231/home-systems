import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { rules } from "../db/schema.js";
import { evaluateCondition, type Cond } from "./dsl.js";

export type RuleRow = typeof rules.$inferSelect;

export type Match = {
  rule: RuleRow;
  action: unknown;
};

export async function loadEnabledRules(domain: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(rules)
    .where(and(eq(rules.domain, domain), eq(rules.enabled, true)))
    .orderBy(asc(rules.priority), asc(rules.id));
}

export function pickFirstMatch(ruleList: RuleRow[], subject: unknown): Match | null {
  for (const rule of ruleList) {
    if (evaluateCondition(rule.match as Cond, subject)) {
      return { rule, action: rule.action };
    }
  }
  return null;
}

export async function evaluate(domain: string, subject: unknown): Promise<Match | null> {
  const enabled = await loadEnabledRules(domain);
  return pickFirstMatch(enabled, subject);
}
