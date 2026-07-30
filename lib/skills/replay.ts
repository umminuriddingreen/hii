export type SkillExecutionEvent = {
  id: string;
  skillId: string;
  daemonRunId: string | null;
  status: 'starting' | 'queued' | 'failed';
  startedAt: string;
  updatedAt: string;
  error?: string;
};

export type SkillDaemonRun = {
  id: string;
  status: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  outputBytes?: number;
};

export type SkillActionReceipt = {
  id?: string;
  createdAt?: string;
  intent?: string;
  outcome?: string;
  verification?: {
    status?: string;
    checks?: unknown[];
    proof?: unknown[];
  };
};

export type SkillReplaySummary = {
  id: string;
  skillId: string;
  daemonRunId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outputBytes: number;
  receiptId: string | null;
  receiptStatus: string;
  outcome: string | null;
  checkCount: number;
  proofCount: number;
  verified: boolean;
  error: string | null;
};

function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function timestamp(value: unknown) {
  const normalized = text(value, 80);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

export function skillReplayReceiptIntent(replayId: string) {
  return `HII skill replay ${replayId}`;
}

export function latestSkillExecutionEvents(events: SkillExecutionEvent[]) {
  const latest = new Map<string, SkillExecutionEvent>();
  for (const event of events) {
    if (!event?.id || !event.skillId) continue;
    const current = latest.get(event.id);
    if (!current || event.updatedAt.localeCompare(current.updatedAt) >= 0) latest.set(event.id, event);
  }
  return [...latest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function summarizeSkillReplay(
  execution: SkillExecutionEvent,
  daemonRun: SkillDaemonRun | null,
  receipts: SkillActionReceipt[]
): SkillReplaySummary {
  const expectedIntent = skillReplayReceiptIntent(execution.id);
  const receipt =
    [...receipts]
      .reverse()
      .find((candidate) => text(candidate.intent, 240) === expectedIntent) || null;
  const startedAt =
    timestamp(daemonRun?.startedAt) ||
    timestamp(daemonRun?.createdAt) ||
    timestamp(execution.startedAt) ||
    execution.startedAt;
  const completedAt =
    timestamp(daemonRun?.completedAt) ||
    (['completed', 'failed', 'cancelled', 'stopped'].includes(String(daemonRun?.status))
      ? timestamp(daemonRun?.updatedAt)
      : null);
  const durationMs =
    startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null;
  const checks = Array.isArray(receipt?.verification?.checks)
    ? receipt.verification.checks.filter(Boolean)
    : [];
  const proof = Array.isArray(receipt?.verification?.proof)
    ? receipt.verification.proof.filter(Boolean)
    : [];
  const receiptStatus = text(receipt?.verification?.status, 40) || 'missing';
  const status = daemonRun?.status || execution.status;

  return {
    id: execution.id,
    skillId: execution.skillId,
    daemonRunId: execution.daemonRunId,
    status,
    startedAt,
    completedAt,
    durationMs,
    outputBytes: Number.isFinite(daemonRun?.outputBytes) ? Number(daemonRun?.outputBytes) : 0,
    receiptId: text(receipt?.id, 160) || null,
    receiptStatus,
    outcome: text(receipt?.outcome, 80) || null,
    checkCount: checks.length,
    proofCount: proof.length,
    verified: receiptStatus === 'verified' && checks.length > 0,
    error: text(execution.error, 500) || null
  };
}

export function compareSkillReplays(current: SkillReplaySummary, previous: SkillReplaySummary | null) {
  if (!previous) return null;
  return {
    currentId: current.id,
    previousId: previous.id,
    statusChanged: current.status !== previous.status,
    outcomeChanged: current.outcome !== previous.outcome,
    verificationChanged: current.receiptStatus !== previous.receiptStatus,
    durationDeltaMs:
      current.durationMs === null || previous.durationMs === null
        ? null
        : current.durationMs - previous.durationMs,
    outputBytesDelta: current.outputBytes - previous.outputBytes,
    checkCountDelta: current.checkCount - previous.checkCount,
    proofCountDelta: current.proofCount - previous.proofCount
  };
}
