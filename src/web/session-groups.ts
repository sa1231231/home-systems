/**
 * Aggregate changelog rows into "session groups" — the natural unit of work
 * in this system. A single cron run, a single UI action, a sync apply, etc.
 * each share a session_id. The per-service Recent activity panels render
 * one row per group with a single Undo button that calls
 * POST /changes/rollback-session/:sessionId to reverse the whole batch.
 */

export type ChangelogRowLike = {
  id: number;
  createdAt: Date;
  caller: string;
  sessionId: string;
  operation: string;
  targetKind: string;
  targetId: string;
  status: string;
  undoneBy: number | null;
};

export type SessionGroup = {
  sessionId: string;
  caller: string;
  startedAt: Date;
  endedAt: Date;
  totalRows: number;
  byOperation: Record<string, number>;
  sampleTargets: Array<{ targetKind: string; targetId: string }>;
  /** success + not yet undone — what rollback-session would actually flip. */
  reversibleCount: number;
  undoneCount: number;
  failedCount: number;
};

const SAMPLE_TARGET_LIMIT = 3;

export function groupBySession(rows: ChangelogRowLike[]): SessionGroup[] {
  const bySession = new Map<string, ChangelogRowLike[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId);
    if (list) list.push(row);
    else bySession.set(row.sessionId, [row]);
  }

  const groups: SessionGroup[] = [];
  for (const [sessionId, sessionRows] of bySession) {
    const sorted = [...sessionRows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const byOperation: Record<string, number> = {};
    const seenTargets = new Set<string>();
    const sampleTargets: Array<{ targetKind: string; targetId: string }> = [];
    let reversibleCount = 0;
    let undoneCount = 0;
    let failedCount = 0;
    for (const r of sorted) {
      byOperation[r.operation] = (byOperation[r.operation] ?? 0) + 1;
      const targetKey = `${r.targetKind}:${r.targetId}`;
      if (!seenTargets.has(targetKey) && sampleTargets.length < SAMPLE_TARGET_LIMIT) {
        seenTargets.add(targetKey);
        sampleTargets.push({ targetKind: r.targetKind, targetId: r.targetId });
      }
      if (r.status === "success" && r.undoneBy === null) reversibleCount++;
      if (r.undoneBy !== null) undoneCount++;
      if (r.status === "failed" || r.status === "error") failedCount++;
    }
    groups.push({
      sessionId,
      caller: sorted[0].caller,
      startedAt: sorted[0].createdAt,
      endedAt: sorted[sorted.length - 1].createdAt,
      totalRows: sorted.length,
      byOperation,
      sampleTargets,
      reversibleCount,
      undoneCount,
      failedCount,
    });
  }

  return groups.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
