export class MissingAnthropicKeyError extends Error {
  constructor() {
    super("anthropic api key not configured");
    this.name = "MissingAnthropicKeyError";
  }
}

export class ClassificationParseError extends Error {
  constructor(
    public readonly classifier: string,
    public readonly callId: number | null,
    public readonly rawOutput: string,
  ) {
    super(`classifier '${classifier}' returned output that did not match the schema`);
    this.name = "ClassificationParseError";
  }
}
