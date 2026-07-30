const boardRunStatuses = new Set([
  'waiting_approval',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

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
