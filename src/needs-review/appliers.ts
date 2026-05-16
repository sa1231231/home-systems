export type ApplyMeta = {
  sessionId: string;
  caller: string;
  intent?: string;
  /** For email reviews: which Gmail account the subject belongs to. */
  account?: string;
};

export type Applier = (
  subjectId: string,
  decision: unknown,
  meta: ApplyMeta,
) => Promise<unknown>;

export class ApplierRegistry {
  private readonly appliers = new Map<string, Applier>();

  register(subjectKind: string, fn: Applier): void {
    if (this.appliers.has(subjectKind)) {
      throw new Error(`applier already registered for '${subjectKind}'`);
    }
    this.appliers.set(subjectKind, fn);
  }

  has(subjectKind: string): boolean {
    return this.appliers.has(subjectKind);
  }

  async apply(
    subjectKind: string,
    subjectId: string,
    decision: unknown,
    meta: ApplyMeta,
  ): Promise<unknown> {
    const fn = this.appliers.get(subjectKind);
    if (!fn) throw new NoApplierError(subjectKind);
    return fn(subjectId, decision, meta);
  }
}

export class NoApplierError extends Error {
  constructor(public readonly subjectKind: string) {
    super(`no applier registered for subject_kind '${subjectKind}'`);
    this.name = "NoApplierError";
  }
}

export const reviewAppliers = new ApplierRegistry();
