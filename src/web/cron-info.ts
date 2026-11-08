import { CronExpressionParser } from "cron-parser";
import { getConfig } from "../config.js";

export type CronInfo = {
  enabled: boolean;
  schedule: string;
  /** IANA TZ in which the schedule is interpreted (e.g. "UTC" or "America/New_York"). */
  scheduleTz: string;
  /** Plain-language frequency, e.g. "Every day at 3:00 AM ET", or null if not phraseable. */
  humanLabel: string | null;
  nextRunUtc: Date | null;
  nextRunUtcLabel: string | null;
  nextRunEtLabel: string | null;
  parseError: string | null;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Short display label for a schedule timezone (e.g. "ET", "UTC", "PST"). */
function tzLabel(tz: string): string {
  if (tz === "UTC") return "UTC";
  if (tz === "America/New_York") return "ET";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Format an hour (0-23) and minute (0-59) as a 12-hour clock, e.g. "3:05 PM". */
function fmtClock(hour: number, minute: number): string {
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function parseInt0to(field: string, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
}

/** Expand a day-of-week field into sorted unique days (0=Sun..6=Sat), or null if unsupported. */
function parseDow(field: string): number[] | null {
  const days = new Set<number>();
  for (const token of field.split(",")) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > 7 || b > 7) return null;
      const lo = a === 7 ? 0 : a;
      const hi = b === 7 ? 0 : b;
      if (lo <= hi) {
        for (let d = lo; d <= hi; d++) days.add(d);
      } else {
        for (let d = lo; d <= 6; d++) days.add(d);
        for (let d = 0; d <= hi; d++) days.add(d);
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n > 7) return null;
      days.add(n === 7 ? 0 : n);
      continue;
    }
    return null; // names, steps, etc. not supported
  }
  return [...days].sort((a, b) => a - b);
}

function describeDays(days: number[]): string {
  const key = days.join(",");
  if (key === "0,1,2,3,4,5,6") return "day";
  if (key === "1,2,3,4,5") return "weekday";
  if (key === "0,6") return "weekend";
  const names = days.map((d) => DAY_NAMES[d]);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Convert a standard 5-field cron expression into a plain-language sentence like
 * "Every day at 3:00 AM ET". Returns null for anything beyond simple daily or
 * day-of-week schedules at a fixed time, so callers can fall back to the raw expression.
 */
export function humanizeSchedule(schedule: string, scheduleTz: string): string | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hr, dom, mon, dow] = fields;

  const minute = parseInt0to(min, 59);
  const hour = parseInt0to(hr, 23);
  if (minute === null || hour === null) return null;
  // Only fixed-time schedules on every month, not restricted to days of the month.
  if (mon !== "*" || dom !== "*") return null;

  const clock = fmtClock(hour, minute);
  const tz = tzLabel(scheduleTz);

  if (dow === "*") return `Every day at ${clock} ${tz}`;

  const days = parseDow(dow);
  if (days === null || days.length === 0) return null;
  return `Every ${describeDays(days)} at ${clock} ${tz}`;
}

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

function compute(schedule: string, enabled: boolean, scheduleTz: string): CronInfo {
  const humanLabel = humanizeSchedule(schedule, scheduleTz);
  if (!enabled) {
    return {
      enabled: false,
      schedule,
      scheduleTz,
      humanLabel,
      nextRunUtc: null,
      nextRunUtcLabel: null,
      nextRunEtLabel: null,
      parseError: null,
    };
  }
  try {
    const it = CronExpressionParser.parse(schedule, { tz: scheduleTz });
    const next = it.next().toDate();
    return {
      enabled: true,
      schedule,
      scheduleTz,
      humanLabel,
      nextRunUtc: next,
      nextRunUtcLabel: fmtUtc(next),
      nextRunEtLabel: fmtEt(next),
      parseError: null,
    };
  } catch (err) {
    return {
      enabled: true,
      schedule,
      scheduleTz,
      humanLabel,
      nextRunUtc: null,
      nextRunUtcLabel: null,
      nextRunEtLabel: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function cronInfoForDomain(domain: "contact" | "transaction" | "trello"): CronInfo {
  const c = getConfig();
  const tz = c.CRON_TZ;
  switch (domain) {
    case "contact":
      return compute(c.CONTACTS_SYNC_CRON_SCHEDULE, c.CONTACTS_SYNC_CRON_ENABLED, tz);
    case "transaction":
      return compute(c.TRANSACTION_TRIAGE_CRON_SCHEDULE, c.TRANSACTION_TRIAGE_CRON_ENABLED, tz);
    case "trello":
      return compute(c.TRELLO_REORDER_CRON_SCHEDULE, c.TRELLO_REORDER_CRON_ENABLED, tz);
  }
}
