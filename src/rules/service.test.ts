import { describe, expect, it } from "vitest";
import { RuleNotFoundError } from "./service.js";

describe("RuleNotFoundError", () => {
  it("exposes the missing id + a 404 status", () => {
    const err = new RuleNotFoundError(42);
    expect(err.id).toBe(42);
    expect(err.status).toBe(404);
    expect(err.message).toContain("42");
    expect(err.name).toBe("RuleNotFoundError");
  });
});
