import { z } from "zod";
import { needsReview } from "../db/schema.js";

export type NeedsReviewRow = typeof needsReview.$inferSelect;

export type PromoteToRule = { name: string; match: unknown };

export type DomainConfig = {
  validateCorrection: (body: unknown) => { category: string };
  defaultRuleName: (entry: NeedsReviewRow) => string;
  defaultMatch: (entry: NeedsReviewRow) => unknown;
  buildCorrectedDecision: (category: string, previousCategory: string) => unknown;
  /**
   * Translate a validated correction body into the rule to promote.
   * Returning `undefined` skips rule promotion (the "just this once" case).
   * If omitted, the route falls back to `{ name: defaultRuleName, match: defaultMatch }`.
   */
  buildPromoteFromCorrection?: (
    entry: NeedsReviewRow,
    body: ReturnType<DomainConfig["validateCorrection"]>,
  ) => PromoteToRule | undefined;
  /** If false, the UI Approve button skips rule promotion (apply once). */
  promotesOnApprove?: boolean;
  /** If false, the Correct flow is disabled for this domain. */
  supportsCorrect?: boolean;
};

const EmailCategoryEnum = z.enum(["noise", "worth_reading", "needs_reply"]);
const EmailRuleScopeEnum = z.enum([
  "exact",
  "from_domain",
  "from_contains",
  "subject_contains",
  "once",
]);
const EmailCorrectBody = z.object({
  category: EmailCategoryEnum,
  rule_scope: EmailRuleScopeEnum.optional(),
  rule_value: z.string().trim().max(200).optional(),
});

const emailConfig: DomainConfig = {
  validateCorrection: (body) => EmailCorrectBody.parse(body),
  defaultRuleName: (entry) => {
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    const account = typeof subj.account === "string" ? subj.account : "";
    const from = typeof subj.from === "string" ? subj.from : "";
    if (from) return `auto: ${account ? account + " " : ""}from=${from.slice(0, 80)}`;
    return `auto: review #${entry.id}`;
  },
  // Email rules are scoped per Gmail account: the match is a compound `all`
  // condition with an `account` leaf plus the sender (or subject) leaf.
  defaultMatch: (entry) => {
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    const account = typeof subj.account === "string" && subj.account ? subj.account : null;
    const accountLeaf = account
      ? [{ op: "equals", field: "account", value: account }]
      : [];
    if (typeof subj.from === "string" && subj.from) {
      return { all: [...accountLeaf, { op: "equals", field: "from", value: subj.from }] };
    }
    if (typeof subj.subject === "string" && subj.subject) {
      return { all: [...accountLeaf, { op: "equals", field: "subject", value: subj.subject }] };
    }
    return { all: [...accountLeaf, { op: "present", field: "from" }] };
  },
  buildCorrectedDecision: (category, previousCategory) => ({
    category,
    reasoning: `user-corrected (was ${previousCategory})`,
  }),
  buildPromoteFromCorrection: (entry, body) => {
    const b = body as { rule_scope?: string; rule_value?: string };
    const scope = b.rule_scope ?? "exact";
    if (scope === "once") return undefined;
    if (scope === "exact") {
      return { name: emailConfig.defaultRuleName(entry), match: emailConfig.defaultMatch(entry) };
    }
    const value = (b.rule_value ?? "").trim();
    if (!value) {
      throw new Error(`rule_value is required for rule_scope=${scope}`);
    }
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    const account = typeof subj.account === "string" && subj.account ? subj.account : "";
    const accountLeaf = account ? [{ op: "equals", field: "account", value: account }] : [];
    const acctPrefix = account ? account + " " : "";
    if (scope === "from_domain") {
      const dom = value.startsWith("@") ? value : `@${value}`;
      return {
        name: `auto: ${acctPrefix}from contains ${dom}`,
        match: { all: [...accountLeaf, { op: "contains", field: "from", value: dom }] },
      };
    }
    if (scope === "from_contains") {
      return {
        name: `auto: ${acctPrefix}from contains ${value.slice(0, 80)}`,
        match: { all: [...accountLeaf, { op: "contains", field: "from", value }] },
      };
    }
    if (scope === "subject_contains") {
      return {
        name: `auto: ${acctPrefix}subject contains ${value.slice(0, 80)}`,
        match: { all: [...accountLeaf, { op: "contains", field: "subject", value }] },
      };
    }
    throw new Error(`unknown rule_scope: ${scope}`);
  },
};

const TransactionCorrectBody = z.object({ category: z.string().min(1).max(200) });

const transactionConfig: DomainConfig = {
  validateCorrection: (body) => TransactionCorrectBody.parse(body),
  defaultRuleName: (entry) => {
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    const full = typeof subj.full_description === "string" ? subj.full_description : "";
    const desc = typeof subj.description === "string" ? subj.description : "";
    const label = (full || desc).trim();
    if (label) return `auto: ${label.slice(0, 80)}`;
    return `auto: review #${entry.id}`;
  },
  defaultMatch: (entry) => {
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    if (typeof subj.full_description === "string" && subj.full_description) {
      return { op: "equals", field: "full_description", value: subj.full_description };
    }
    if (typeof subj.description === "string" && subj.description) {
      return { op: "equals", field: "description", value: subj.description };
    }
    return { op: "present", field: "transaction_id" };
  },
  buildCorrectedDecision: (category, previousCategory) => ({
    category,
    reasoning: `user-corrected (was ${previousCategory})`,
  }),
};

const contactConfig: DomainConfig = {
  // Contacts sync rows carry a concrete sheet operation in proposed_action, not
  // a category. There is no "wrong category, pick a different one" mode for
  // these — the user either accepts the sheet change as-is or skips it.
  validateCorrection: () => {
    throw new UnknownDomainError("contact: correction not supported");
  },
  defaultRuleName: (entry) => `contact: review #${entry.id}`,
  defaultMatch: () => ({ op: "present", field: "google_resource_name" }),
  buildCorrectedDecision: () => {
    throw new UnknownDomainError("contact: correction not supported");
  },
  promotesOnApprove: false,
  supportsCorrect: false,
};

const configs: Record<string, DomainConfig> = {
  email: emailConfig,
  transaction: transactionConfig,
  contact: contactConfig,
};

export class UnknownDomainError extends Error {
  readonly status = 400;
  constructor(readonly domain: string) {
    super(`no domain config registered for "${domain}"`);
    this.name = "UnknownDomainError";
  }
}

export function getDomainConfig(domain: string): DomainConfig {
  const c = configs[domain];
  if (!c) throw new UnknownDomainError(domain);
  return c;
}
