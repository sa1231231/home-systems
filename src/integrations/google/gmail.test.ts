import { describe, expect, it } from "vitest";
import { parseMessage, type RawGmailMessage } from "./gmail.js";

describe("parseMessage", () => {
  it("extracts headers, labels, snippet, and date", () => {
    const raw: RawGmailMessage = {
      id: "msg1",
      threadId: "th1",
      snippet: "Hi there",
      labelIds: ["INBOX", "UNREAD"],
      internalDate: "1715366400000",
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "me@home.com" },
          { name: "Subject", value: "Hello" },
        ],
      },
    };
    const m = parseMessage(raw);
    expect(m.id).toBe("msg1");
    expect(m.threadId).toBe("th1");
    expect(m.from).toBe("alice@example.com");
    expect(m.to).toBe("me@home.com");
    expect(m.subject).toBe("Hello");
    expect(m.snippet).toBe("Hi there");
    expect(m.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(m.receivedAt).toEqual(new Date(1715366400000));
  });

  it("handles missing headers and missing date", () => {
    const m = parseMessage({ id: "x", threadId: "y", payload: { headers: [] } });
    expect(m.from).toBeNull();
    expect(m.subject).toBeNull();
    expect(m.snippet).toBe("");
    expect(m.labelIds).toEqual([]);
    expect(m.receivedAt).toBeNull();
  });

  it("matches header names case-insensitively", () => {
    const m = parseMessage({
      payload: { headers: [{ name: "from", value: "x@y.z" }] },
    });
    expect(m.from).toBe("x@y.z");
  });
});
