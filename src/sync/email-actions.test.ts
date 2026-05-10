import { describe, expect, it } from "vitest";
import { planEmailReversal, planLabelChange } from "./email-actions.js";
import type { ChangelogRow } from "../changelog/types.js";

describe("planLabelChange", () => {
  it("adds new labels and reports adds", () => {
    const r = planLabelChange(["INBOX"], { add_labels: ["IMPORTANT"], remove_labels: [] });
    expect(r.afterLabels).toEqual(["IMPORTANT", "INBOX"]);
    expect(r.added).toEqual(["IMPORTANT"]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toBe(true);
  });

  it("removes existing labels and reports removes", () => {
    const r = planLabelChange(["INBOX", "UNREAD"], { add_labels: [], remove_labels: ["INBOX"] });
    expect(r.afterLabels).toEqual(["UNREAD"]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual(["INBOX"]);
    expect(r.changed).toBe(true);
  });

  it("ignores idempotent ops (no change)", () => {
    const r = planLabelChange(["INBOX"], { add_labels: ["INBOX"], remove_labels: ["UNREAD"] });
    expect(r.changed).toBe(false);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("processes removes before adds", () => {
    const r = planLabelChange(["INBOX"], { add_labels: ["INBOX"], remove_labels: ["INBOX"] });
    // remove "INBOX" first → set is empty → add "INBOX" back. Net: no change.
    // The reported "added"/"removed" reflect what actually happened relative to the start.
    expect(r.afterLabels).toEqual(["INBOX"]);
    expect(r.changed).toBe(false);
  });

  it("returns sorted afterLabels", () => {
    const r = planLabelChange(["UNREAD"], { add_labels: ["STARRED", "IMPORTANT"], remove_labels: [] });
    expect(r.afterLabels).toEqual(["IMPORTANT", "STARRED", "UNREAD"]);
  });
});

describe("planEmailReversal", () => {
  it("swaps add/remove sets from beforeState", () => {
    const entry: ChangelogRow = {
      id: 1,
      createdAt: new Date(),
      caller: "test",
      sessionId: "s",
      operation: "email.modify_labels",
      targetKind: "email",
      targetId: "msg1",
      intent: null,
      beforeState: { labels: ["INBOX"], removed: ["INBOX"], added: ["MyLabel"] },
      afterState: { labels: ["MyLabel"] },
      externalTarget: "gmail:message:msg1",
      status: "success",
      error: null,
      undoneBy: null,
    };
    expect(planEmailReversal(entry)).toEqual({
      addLabelIds: ["INBOX"], // restore what was removed
      removeLabelIds: ["MyLabel"], // undo what was added
    });
  });

  it("handles entries with no add or remove deltas", () => {
    const entry: ChangelogRow = {
      id: 1,
      createdAt: new Date(),
      caller: "test",
      sessionId: "s",
      operation: "email.modify_labels",
      targetKind: "email",
      targetId: "msg1",
      intent: null,
      beforeState: { labels: ["INBOX"] },
      afterState: { labels: ["INBOX"] },
      externalTarget: "gmail:message:msg1",
      status: "success",
      error: null,
      undoneBy: null,
    };
    expect(planEmailReversal(entry)).toEqual({ addLabelIds: [], removeLabelIds: [] });
  });
});
