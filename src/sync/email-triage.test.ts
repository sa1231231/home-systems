import { describe, expect, it } from "vitest";
import {
  buildClassifierInput,
  buildSubject,
  mapCategoryToAction,
  ProposedActionSchema,
} from "./email-triage.js";
import type { GmailMetadata } from "../integrations/google/gmail.js";

const SAMPLE: GmailMetadata = {
  id: "msg1",
  threadId: "th1",
  from: "alice@example.com",
  to: "me@home.com",
  subject: "Welcome to Acme!",
  snippet: "Click here to get started",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  receivedAt: new Date("2026-05-10T12:00:00.000Z"),
};

describe("buildSubject", () => {
  it("flattens metadata into the rules-engine subject shape", () => {
    expect(buildSubject(SAMPLE)).toEqual({
      from: "alice@example.com",
      to: "me@home.com",
      subject: "Welcome to Acme!",
      snippet: "Click here to get started",
      labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
      received_at: "2026-05-10T12:00:00.000Z",
    });
  });

  it("handles missing headers and date", () => {
    const partial: GmailMetadata = {
      id: "x",
      threadId: "y",
      from: null,
      to: null,
      subject: null,
      snippet: "",
      labelIds: [],
      receivedAt: null,
    };
    const s = buildSubject(partial);
    expect(s.from).toBeNull();
    expect(s.received_at).toBeNull();
    expect(s.labels).toEqual([]);
  });
});

describe("buildClassifierInput", () => {
  it("produces a labelled, line-separated representation for the AI", () => {
    const input = buildClassifierInput(SAMPLE);
    expect(input).toContain("From: alice@example.com");
    expect(input).toContain("To: me@home.com");
    expect(input).toContain("Subject: Welcome to Acme!");
    expect(input).toContain("Labels: INBOX, UNREAD, CATEGORY_PROMOTIONS");
    expect(input).toContain("Snippet: Click here to get started");
  });

  it("falls back to placeholders for missing fields", () => {
    const partial: GmailMetadata = {
      id: "x",
      threadId: "y",
      from: null,
      to: null,
      subject: null,
      snippet: "",
      labelIds: [],
      receivedAt: null,
    };
    const input = buildClassifierInput(partial);
    expect(input).toContain("From: (unknown)");
    expect(input).toContain("Subject: (none)");
    expect(input).toContain("Labels: (none)");
  });
});

describe("ProposedActionSchema", () => {
  it("accepts each of the three valid categories", () => {
    for (const category of ["noise", "worth_reading", "needs_reply"] as const) {
      const parsed = ProposedActionSchema.parse({ category, reasoning: "x" });
      expect(parsed.category).toBe(category);
    }
  });

  it("rejects unknown categories", () => {
    expect(() => ProposedActionSchema.parse({ category: "spam", reasoning: "x" })).toThrow();
  });

  it("rejects empty reasoning", () => {
    expect(() =>
      ProposedActionSchema.parse({ category: "noise", reasoning: "" }),
    ).toThrow();
  });
});

describe("mapCategoryToAction", () => {
  it("noise -> archive (remove INBOX, no adds)", () => {
    const a = mapCategoryToAction({ category: "noise", reasoning: "newsletter" });
    expect(a.remove_labels).toEqual(["INBOX"]);
    expect(a.add_labels).toEqual([]);
    expect(a.reasoning).toBe("newsletter");
  });

  it("worth_reading -> no-op (no label changes)", () => {
    const a = mapCategoryToAction({ category: "worth_reading", reasoning: "fyi" });
    expect(a.remove_labels).toEqual([]);
    expect(a.add_labels).toEqual([]);
  });

  it("needs_reply -> star (add STARRED, leave inbox)", () => {
    const a = mapCategoryToAction({ category: "needs_reply", reasoning: "needs reply" });
    expect(a.add_labels).toEqual(["STARRED"]);
    expect(a.remove_labels).toEqual([]);
  });
});
