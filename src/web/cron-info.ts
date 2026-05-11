import { CronExpressionParser } from "cron-parser";
import { getConfig } from "../config.js";

export type CronInfo = {
  enabled: boolean;
  schedule: string;
  nextRunUtc: Date | null;
  nextRunUtcLabel: string | null;
  nextRunEtLabel: string | null;
  parseError: string | null;
};

function fmtUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function fmtEt(d: Date): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}

function compute(schedule: string, enabled: boolean): CronInfo {
  if (!enabled) {
    return {
      enabled: false,
      schedule,
      nextRunUtc: null,
      nextRunUtcLabel: null,
      nextRunEtLabel: null,
      parseError: null,
    };
  }
  try {
    const it = CronExpressionParser.parse(schedule, { tz: "UTC" });
    const next = it.next().toDate();
    return {
      enabled: true,
      schedule,
      nextRunUtc: next,
      nextRunUtcLabel: fmtUtc(next),
      nextRunEtLabel: fmtEt(next),
      parseError: null,
    };
  } catch (err) {
    return {
      enabled: true,
      schedule,
      nextRunUtc: null,
      nextRunUtcLabel: null,
      nextRunEtLabel: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function cronInfoForDomain(domain: "email" | "contact" | "transaction" | "trello"): CronInfo {
  const c = getConfig();
  switch (domain) {
    case "email":
      return compute(c.EMAIL_TRIAGE_CRON_SCHEDULE, c.EMAIL_TRIAGE_CRON_ENABLED);
    case "contact":
      return compute(c.CONTACTS_SYNC_CRON_SCHEDULE, c.CONTACTS_SYNC_CRON_ENABLED);
    case "transaction":
      return compute(c.TRANSACTION_TRIAGE_CRON_SCHEDULE, c.TRANSACTION_TRIAGE_CRON_ENABLED);
    case "trello":
      return compute(c.TRELLO_REORDER_CRON_SCHEDULE, c.TRELLO_REORDER_CRON_ENABLED);
  }
}
