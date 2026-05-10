import { describe, expect, it } from "vitest";
import { buildClassifierInput, buildSubject, ProposedActionSchema } from "./email-triage.js";
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
  it("accepts a fully-specified action", () => {
    const parsed = ProposedActionSchema.parse({
      add_labels: ["IMPORTANT"],
      remove_labels: ["INBOX"],
      reasoning: "obvious newsletter",
    });
    expect(parsed.add_labels).toEqual(["IMPORTANT"]);
    expect(parsed.remove_labels).toEqual(["INBOX"]);
  });

  it("defaults add/remove to empty arrays", () => {
    const parsed = ProposedActionSchema.parse({ reasoning: "no-op leave in inbox" });
    expect(parsed.add_labels).toEqual([]);
    expect(parsed.remove_labels).toEqual([]);
  });

  it("rejects empty reasoning", () => {
    expect(() =>
      ProposedActionSchema.parse({ add_labels: [], remove_labels: [], reasoning: "" }),
    ).toThrow();
  });
});
