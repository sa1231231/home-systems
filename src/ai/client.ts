import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import { MissingAnthropicKeyError } from "./errors.js";

let cached: Anthropic | undefined;

export function getAnthropicClient(): Anthropic {
  if (cached) return cached;
  const c = getConfig();
  if (!c.ANTHROPIC_API_KEY) throw new MissingAnthropicKeyError();
  cached = new Anthropic({ apiKey: c.ANTHROPIC_API_KEY });
  return cached;
}

export function resetAnthropicClient(): void {
  cached = undefined;
}
