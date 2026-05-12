import { z } from "zod";
import { needsReview } from "../db/schema.js";

export type NeedsReviewRow = typeof needsReview.$inferSelect;

export type DomainConfig = {
  validateCorrection: (body: unknown) => { category: string };
  defaultRuleName: (entry: NeedsReviewRow) => string;
  defaultMatch: (entry: NeedsReviewRow) => unknown;
  buildCorrectedDecision: (category: string, previousCategory: string) => unknown;
  /** If false, the UI Approve button skips rule promotion (apply once). */
  promotesOnApprove?: boolean;
  /** If false, the Correct flow is disabled for this domain. */
  supportsCorrect?: boolean;
};

const EmailCategoryEnum = z.enum(["noise", "worth_reading", "needs_reply"]);
const EmailCorrectBody = z.object({ category: EmailCategoryEnum });

const emailConfig: DomainConfig = {
  validateCorrection: (body) => EmailCorrectBody.parse(body),
  defaultRuleName: (entry) => {
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    const from = typeof subj.from === "string" ? subj.from : "";
    if (from) return `auto: from=${from.slice(0, 80)}`;
    return `auto: review #${entry.id}`;
  },
  defaultMatch: (entry) => {
    const subj = (entry.subject ?? {}) as Record<string, unknown>;
    if (typeof subj.from === "string" && subj.from) {
      return { op: "equals", field: "from", value: subj.from };
    }
    if (typeof subj.subject === "string" && subj.subject) {
      return { op: "equals", field: "subject", value: subj.subject };
    }
    return { op: "present", field: "from" };
  },
  buildCorrectedDecision: (category, previousCategory) => ({
    category,
    reasoning: `user-corrected (was ${previousCategory})`,
  }),
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
