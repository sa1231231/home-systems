export type LogEntryInput = {
  caller: string;
  sessionId: string;
  operation: string;
  targetKind: string;
  targetId: string;
  intent?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  externalTarget?: string;
};

export type ChangelogRow = {
  id: number;
  createdAt: Date;
  caller: string;
  sessionId: string;
  operation: string;
  targetKind: string;
  targetId: string;
  intent: string | null;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  externalTarget: string | null;
  status: "pending" | "success" | "failed";
  error: string | null;
  undoneBy: number | null;
};
