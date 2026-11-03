export const boardRunStatusValues = [
  'waiting_approval',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
] as const;

export type BoardRunStatus = typeof boardRunStatusValues[number];
export type BoardRunLane = 'backlog' | 'next' | 'doing' | 'blocked' | 'done';

const boardRunStatuses = new Set<string>(boardRunStatusValues);

function runStatus(value: unknown): BoardRunStatus | null {
  const status = String(value ?? '');
  return boardRunStatuses.has(status) ? status as BoardRunStatus : null;
}

export function boardRunSyncKey(input: {
  status: unknown;
  runId: unknown;
  receiptRef?: unknown;
}) {
  const status = String(input.status ?? '');
  const runId = String(input.runId ?? '');
  if (!boardRunStatuses.has(status) || !runId) return '';
  return `${status}:${runId}:${String(input.receiptRef ?? '')}`;
}

export function boardPatchForRunState(input: {
  status: unknown;
  runId: unknown;
  receiptRef?: unknown;
  currentLane?: unknown;
}) {
  const status = runStatus(input.status);
  const runId = String(input.runId ?? '');
  const receiptRef = String(input.receiptRef ?? '');
  if (!status) throw new Error('Board run status is not recognized.');
  if (!runId) throw new Error('A board run link requires a run id.');

  const patch: {
    runId: string;
    runStatus: BoardRunStatus;
    lane?: BoardRunLane;
    receiptRef?: string;
  } = { runId, runStatus: status };

  if (status === 'waiting_approval' && input.currentLane === 'blocked') patch.lane = 'next';
  if (status === 'queued' || status === 'running') patch.lane = 'doing';
  if (status === 'failed' || status === 'cancelled') patch.lane = 'blocked';
  if (status === 'completed') {
    if (!receiptRef) throw new Error('A completed board run requires a receipt reference.');
    patch.lane = 'done';
    patch.receiptRef = receiptRef;
  }
  return patch;
}
