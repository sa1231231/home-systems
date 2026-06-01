import { describe, it, expect } from "vitest";
import {
  findBirthdayTriggers,
  formatBirthdayMessage,
  parseBirthday,
} from "./birthday-reminders.js";

function row(fields: Record<string, string>, rowIndex = 0) {
  return { rowIndex, record: fields };
}

/** Helper: build a UTC Date for a given Y/M/D (1-indexed month). */
function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe("parseBirthday", () => {
  it("parses YYYY-MM-DD", () => {
    expect(parseBirthday("1992-06-07")).toEqual({ year: 1992, month: 6, day: 7 });
  });
  it("parses single-digit months/days", () => {
    expect(parseBirthday("1992-6-7")).toEqual({ year: 1992, month: 6, day: 7 });
  });
  it("parses MM-DD without year", () => {
    expect(parseBirthday("06-07")).toEqual({ year: null, month: 6, day: 7 });
  });
  it("returns null for empty / garbage / impossible dates", () => {
    expect(parseBirthday("")).toBeNull();
    expect(parseBirthday("   ")).toBeNull();
    expect(parseBirthday("hello")).toBeNull();
    expect(parseBirthday("2026-13-05")).toBeNull(); // month > 12
    expect(parseBirthday("2026-02-30")).toBeNull(); // Feb 30 doesn't exist
    expect(parseBirthday("1990/06/07")).toBeNull(); // wrong separator
  });
  it("permits Feb 29 as a valid date", () => {
    expect(parseBirthday("02-29")).toEqual({ year: null, month: 2, day: 29 });
    expect(parseBirthday("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
  });
});

describe("findBirthdayTriggers", () => {
  it("fires at lookahead 7", () => {
    const t = findBirthdayTriggers(utc(2026, 5, 31), [
      row({ full_name: "Jane Doe", birthday: "1992-06-07", google_resource_name: "people/c1" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(7);
    expect(t[0].refYear).toBe(2026);
    expect(t[0].turning).toBe(2026 - 1992);
    expect(t[0].subjectId).toBe("people/c1");
    expect(t[0].birthdayDate).toEqual({ year: 2026, month: 6, day: 7 });
  });

  it("fires at lookahead 0 (day-of)", () => {
    const t = findBirthdayTriggers(utc(2026, 6, 7), [
      row({ full_name: "Jane", birthday: "1992-06-07", google_resource_name: "people/c1" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(0);
    expect(t[0].refYear).toBe(2026);
  });

  it("does NOT fire 8 days out", () => {
    const t = findBirthdayTriggers(utc(2026, 5, 30), [
      row({ full_name: "J", birthday: "1992-06-07" }),
    ]);
    expect(t).toHaveLength(0);
  });

  it("does NOT fire 1 day out (current schedule is 7+0 only)", () => {
    const t = findBirthdayTriggers(utc(2026, 6, 6), [
      row({ full_name: "J", birthday: "1992-06-07" }),
    ]);
    expect(t).toHaveLength(0);
  });

  it("year-wrap: today late Dec, birthday early Jan → fires 7d for next year", () => {
    const t = findBirthdayTriggers(utc(2026, 12, 28), [
      row({ full_name: "Yvonne", birthday: "1990-01-04" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(7);
    expect(t[0].refYear).toBe(2027);
    expect(t[0].turning).toBe(2027 - 1990);
  });

  it("MM-DD only: turning is null but trigger still fires", () => {
    const t = findBirthdayTriggers(utc(2026, 5, 31), [
      row({ full_name: "Sam", birthday: "06-07" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].turning).toBeNull();
    expect(t[0].refYear).toBe(2026);
  });

  it("Feb 29 birthday fires on Feb 28 in non-leap years", () => {
    // 2026 is not a leap year.
    const t = findBirthdayTriggers(utc(2026, 2, 28), [
      row({ full_name: "Leap", birthday: "2000-02-29" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(0);
    expect(t[0].birthdayDate).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it("Feb 29 birthday fires on Feb 29 in leap years", () => {
    // 2028 is a leap year.
    const t = findBirthdayTriggers(utc(2028, 2, 29), [
      row({ full_name: "Leap", birthday: "2000-02-29" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(0);
    expect(t[0].birthdayDate).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it("Feb 29 birthday: 7-day lookahead in non-leap year hits Feb 21", () => {
    const t = findBirthdayTriggers(utc(2026, 2, 21), [
      row({ full_name: "Leap", birthday: "2000-02-29" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(7);
    expect(t[0].birthdayDate).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it("empty birthday: skipped", () => {
    const t = findBirthdayTriggers(utc(2026, 6, 7), [
      row({ full_name: "Jane", birthday: "" }),
      row({ full_name: "Sam" }, 1), // no birthday key at all
    ]);
    expect(t).toHaveLength(0);
  });

  it("malformed birthday: skipped, sibling row still fires", () => {
    const t = findBirthdayTriggers(utc(2026, 6, 7), [
      row({ full_name: "Bad", birthday: "garbage" }),
      row({ full_name: "Good", birthday: "06-07" }, 1),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].fullName).toBe("Good");
  });

  it("subjectId prefers google_resource_name, then email, then name+row", () => {
    const t = findBirthdayTriggers(utc(2026, 6, 7), [
      row({ full_name: "A", birthday: "06-07", google_resource_name: "people/c1" }, 0),
      row({ full_name: "B", birthday: "06-07", email: "b@example.com" }, 1),
      row({ full_name: "C", birthday: "06-07" }, 2),
    ]);
    expect(t).toHaveLength(3);
    expect(t[0].subjectId).toBe("people/c1");
    expect(t[1].subjectId).toBe("email:b@example.com");
    expect(t[2].subjectId).toBe("name:C|row:2");
  });

  it("today is the birthday AND 7 days from itself: only day-of fires (no double-count)", () => {
    // Sanity — a single contact shouldn't somehow match both 7 and 0 on the same day.
    const t = findBirthdayTriggers(utc(2026, 6, 7), [
      row({ full_name: "Jane", birthday: "1992-06-07" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].lookaheadDays).toBe(0);
  });
});

describe("formatBirthdayMessage", () => {
  it("day-of message uses red and exhorts to text", () => {
    const trig = {
      contact: row({}, 0),
      fullName: "Jane Doe",
      subjectId: "people/c1",
      lookaheadDays: 0 as const,
      refYear: 2026,
      birthdayDate: { year: 2026, month: 6, day: 7 },
      turning: 34,
    };
    const m = formatBirthdayMessage(trig);
    expect(m.title).toContain("Today");
    expect(m.title).toContain("Jane Doe");
    expect(m.title).toContain("34");
    expect(m.color).toBe(0xff4444);
  });

  it("7-day message uses gold and announces days-until", () => {
    const trig = {
      contact: row({}, 0),
      fullName: "Sam",
      subjectId: "people/c2",
      lookaheadDays: 7 as const,
      refYear: 2026,
      birthdayDate: { year: 2026, month: 6, day: 7 },
      turning: null,
    };
    const m = formatBirthdayMessage(trig);
    expect(m.title).toContain("7 days");
    expect(m.title).toContain("Sam");
    expect(m.title).not.toContain("turning"); // year unknown → no age
    expect(m.color).toBe(0xffd700);
  });
});
