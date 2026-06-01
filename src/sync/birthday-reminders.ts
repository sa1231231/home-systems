/**
 * Birthday reminders — daily cron logic.
 *
 * Pure date math (`findBirthdayTriggers`, `parseBirthday`) is exported so it
 * can be unit-tested without a database or Discord. The orchestrator
 * (`runBirthdayReminders`) reads the dex_contacts sheet, filters out any
 * (contact, year, lookahead) combo we've already successfully notified on,
 * sends what remains via the channel-agnostic notify client, and records
 * every attempt — success or failure — in `notification_log`.
 *
 * Lookahead schedule per birthday: 7 days before + day-of. Two notifications
 * per contact per year. To change this, edit `LOOKAHEAD_DAYS` below; the
 * dedup ledger keys on lookahead so adding a new offset will not re-fire
 * the existing ones.
 */

import type { OAuth2Client } from "google-auth-library";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notificationLog } from "../db/schema.js";
import { readContactsTab } from "../integrations/google/sheets.js";
import {
  hasNotificationChannel,
  sendNotification,
  type NotificationField,
} from "../integrations/notify/client.js";

/** Lookahead offsets we fire on. Keep ordered so dual-fire (e.g. someone
 *  whose birthday lands exactly on a 7-day boundary today) is deterministic. */
const LOOKAHEAD_DAYS = [7, 0] as const;
type Lookahead = (typeof LOOKAHEAD_DAYS)[number];

export type SheetContactRow = {
  rowIndex: number;
  record: Record<string, string>;
};

export type BirthdayTrigger = {
  contact: SheetContactRow;
  fullName: string;
  /** Stable identifier for dedup. Prefers google_resource_name; falls back
   *  to email, then name+row. See `resolveSubjectId`. */
  subjectId: string;
  lookaheadDays: Lookahead;
  /** Calendar year of the upcoming birthday — could be next year if the
   *  birthday already passed this year and we're looking ahead to its
   *  next occurrence. */
  refYear: number;
  /** The exact calendar date the birthday occurs on this round.
   *  Feb 29 birthdays in non-leap years are normalized to Feb 28 here. */
  birthdayDate: { year: number; month: number; day: number };
  /** Age this birthday — null if the source data was "MM-DD" only. */
  turning: number | null;
};

export type ReminderSummary = {
  matched: number;
  sent: number;
  skipped: number;
  errors: number;
};

// ---------------------------------------------------------------------------
// Pure helpers (testable, no I/O)
// ---------------------------------------------------------------------------

/** Parse a birthday cell. Accepts "YYYY-MM-DD" or "MM-DD". Returns null
 *  for empty or malformed input — caller logs and skips. */
export function parseBirthday(
  raw: string,
): { year: number | null; month: number; day: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (!isValidDate(year, month, day)) return null;
    return { year, month, day };
  }
  const md = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (!isValidMonthDay(month, day)) return null;
    return { year: null, month, day };
  }
  return null;
}

function isValidMonthDay(month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Use 2000 (a leap year) as the reference so Feb 29 validates as a real date.
  const ref = new Date(Date.UTC(2000, month - 1, day));
  return ref.getUTCMonth() + 1 === month && ref.getUTCDate() === day;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (!isValidMonthDay(month, day)) return false;
  if (year < 1900 || year > 2100) return false;
  const ref = new Date(Date.UTC(year, month - 1, day));
  return (
    ref.getUTCFullYear() === year &&
    ref.getUTCMonth() + 1 === month &&
    ref.getUTCDate() === day
  );
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

type CalDate = { year: number; month: number; day: number };

/** Extract calendar date from a JS Date using UTC fields. The birthday cron
 *  fires at 08:00 America/New_York (= 12:00–13:00 UTC depending on DST), so
 *  the UTC calendar date always matches the local-ET calendar date. */
function dateToCalendar(d: Date): CalDate {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function calendarDaysBetween(from: CalDate, to: CalDate): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

/** Resolve (month, day) to its next occurrence on/after today. Feb 29 in a
 *  non-leap target year rolls to Feb 28 so the reminder still fires that year. */
function nextOccurrence(today: CalDate, month: number, day: number): CalDate {
  const adjust = (yr: number): { month: number; day: number } =>
    month === 2 && day === 29 && !isLeapYear(yr) ? { month: 2, day: 28 } : { month, day };

  let yr = today.year;
  let adj = adjust(yr);
  let candidate: CalDate = { year: yr, month: adj.month, day: adj.day };
  if (calendarDaysBetween(today, candidate) >= 0) return candidate;
  // Already passed this year — roll to next year.
  yr += 1;
  adj = adjust(yr);
  return { year: yr, month: adj.month, day: adj.day };
}

/** Resolve a stable subject id for dedup. Order: google_resource_name (best),
 *  email, then name+rowIndex as a best-effort fallback. */
function resolveSubjectId(record: Record<string, string>, rowIndex: number): string {
  const rn = (record.google_resource_name ?? "").trim();
  if (rn) return rn;
  const email = (record.email ?? "").trim();
  if (email) return `email:${email.toLowerCase()}`;
  const name = (record.full_name ?? "").trim();
  if (name) return `name:${name}|row:${rowIndex}`;
  return `row:${rowIndex}`;
}

export function findBirthdayTriggers(
  today: Date,
  rows: SheetContactRow[],
): BirthdayTrigger[] {
  const todayCal = dateToCalendar(today);
  const out: BirthdayTrigger[] = [];

  for (const row of rows) {
    const raw = (row.record.birthday ?? "").trim();
    if (!raw) continue;
    const parsed = parseBirthday(raw);
    if (!parsed) {
      console.warn(`[birthday] skipping row ${row.rowIndex}: unparseable birthday "${raw}"`);
      continue;
    }
    const occ = nextOccurrence(todayCal, parsed.month, parsed.day);
    const days = calendarDaysBetween(todayCal, occ);
    for (const lookahead of LOOKAHEAD_DAYS) {
      if (days !== lookahead) continue;
      const fullName = (row.record.full_name ?? "").trim() || "(no name)";
      const subjectId = resolveSubjectId(row.record, row.rowIndex);
      const turning = parsed.year != null ? occ.year - parsed.year : null;
      out.push({
        contact: row,
        fullName,
        subjectId,
        lookaheadDays: lookahead,
        refYear: occ.year,
        birthdayDate: occ,
        turning,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatBirthdayDate(d: CalDate): string {
  const weekday = WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];
  return `${weekday}, ${MONTHS[d.month - 1]} ${d.day}`;
}

export function formatBirthdayMessage(trig: BirthdayTrigger): {
  title: string;
  body: string;
  fields: NotificationField[];
  color: number;
  /** Single-line plain-text version. Discord renders this in the visible
   *  message body so the reminder is readable even when embeds are hidden
   *  (channel role lacks "Embed Links"). */
  content: string;
} {
  const nameLine =
    trig.turning != null ? `${trig.fullName} (turning ${trig.turning})` : trig.fullName;
  const dateStr = formatBirthdayDate(trig.birthdayDate);
  if (trig.lookaheadDays === 0) {
    return {
      title: `🎂 Today: ${nameLine}`,
      body: "Don't forget to text!",
      fields: [{ name: "Date", value: dateStr, inline: true }],
      color: 0xff4444, // red — urgent
      content: `🎂 **${nameLine}**'s birthday is today (${dateStr}) — don't forget to text!`,
    };
  }
  return {
    title: `🎂 Birthday in ${trig.lookaheadDays} days — ${nameLine}`,
    body: dateStr,
    fields: [{ name: "Date", value: dateStr, inline: true }],
    color: 0xffd700, // gold — heads-up
    content: `🎂 **${nameLine}**'s birthday is in ${trig.lookaheadDays} days — ${dateStr}.`,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator (does I/O: sheet read + DB read/write + HTTP)
// ---------------------------------------------------------------------------

export async function runBirthdayReminders(opts: {
  oauth: OAuth2Client;
  sheetId: string;
  sessionId: string;
  /** Inject "today" for tests / one-shot scripts. Defaults to now. */
  today?: Date;
  /** Sheet tab. Defaults to "dex_contacts". */
  tab?: string;
}): Promise<ReminderSummary> {
  const today = opts.today ?? new Date();
  const tabName = opts.tab ?? "dex_contacts";

  if (!hasNotificationChannel()) {
    console.warn(
      "[birthday] no notification channel configured (set DISCORD_WEBHOOK_URL); skipping run",
    );
    return { matched: 0, sent: 0, skipped: 0, errors: 0 };
  }

  console.log(`[birthday] sessionId=${opts.sessionId} reading ${tabName}...`);
  const sheet = await readContactsTab(opts.oauth, opts.sheetId, { tab: tabName });
  const triggers = findBirthdayTriggers(today, sheet.rows);
  console.log(`[birthday] matched ${triggers.length} trigger(s) from ${sheet.rows.length} rows`);

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const trig of triggers) {
    const prior = await db
      .select({ id: notificationLog.id })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.kind, "birthday"),
          eq(notificationLog.subjectKind, "contact"),
          eq(notificationLog.subjectId, trig.subjectId),
          eq(notificationLog.refYear, trig.refYear),
          eq(notificationLog.lookaheadDays, trig.lookaheadDays),
          eq(notificationLog.deliveryStatus, "sent"),
        ),
      )
      .limit(1);
    if (prior.length > 0) {
      skipped += 1;
      continue;
    }

    const message = formatBirthdayMessage(trig);
    const outcome = await sendNotification(message);

    await db.insert(notificationLog).values({
      kind: "birthday",
      subjectKind: "contact",
      subjectId: trig.subjectId,
      refYear: trig.refYear,
      lookaheadDays: trig.lookaheadDays,
      channel: outcome.channel,
      payload: {
        title: message.title,
        body: message.body,
        fields: message.fields,
        fullName: trig.fullName,
        turning: trig.turning,
      },
      deliveryStatus: outcome.delivered ? "sent" : "failed",
      deliveryError: outcome.error,
    });

    if (outcome.delivered) {
      sent += 1;
    } else {
      errors += 1;
      console.error(
        `[birthday] send failed for ${trig.fullName} (${trig.subjectId}) lookahead=${trig.lookaheadDays}: ${outcome.error}`,
      );
    }
  }

  return { matched: triggers.length, sent, skipped, errors };
}
