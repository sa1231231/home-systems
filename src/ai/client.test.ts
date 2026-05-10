import { describe, expect, it } from "vitest";
import { getAnthropicClient } from "./client.js";
import { MissingAnthropicKeyError } from "./errors.js";

describe("MissingAnthropicKeyError", () => {
  it("has a stable name and message", () => {
    const err = new MissingAnthropicKeyError();
    expect(err.name).toBe("MissingAnthropicKeyError");
    expect(err.message).toMatch(/anthropic api key/i);
  });
});

describe("getAnthropicClient", () => {
  it("throws MissingAnthropicKeyError when ANTHROPIC_API_KEY is unset", () => {
    if (process.env.ANTHROPIC_API_KEY) return; // skip if a real key is set in the dev shell
    expect(() => getAnthropicClient()).toThrow(MissingAnthropicKeyError);
  });
});
