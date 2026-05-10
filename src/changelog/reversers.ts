import type { ChangelogRow } from "./types.js";

export type Reverser = (entry: ChangelogRow) => Promise<void>;

export class NoReverserError extends Error {
  constructor(public readonly operation: string) {
    super(`no reverser registered for operation '${operation}'`);
    this.name = "NoReverserError";
  }
}

export class ReverserRegistry {
  private readonly reversers = new Map<string, Reverser>();

  register(operation: string, fn: Reverser): void {
    if (this.reversers.has(operation)) {
      throw new Error(`reverser already registered for '${operation}'`);
    }
    this.reversers.set(operation, fn);
  }

  has(operation: string): boolean {
    return this.reversers.has(operation);
  }

  async reverse(entry: ChangelogRow): Promise<void> {
    const fn = this.reversers.get(entry.operation);
    if (!fn) throw new NoReverserError(entry.operation);
    await fn(entry);
  }
}

export const registry = new ReverserRegistry();
