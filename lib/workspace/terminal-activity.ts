import type { AgentEventV1 } from '@/lib/client/hii-bridge';

function textLines(value: unknown) {
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string' && Boolean(line)) : [];
}

/** Reduce streamed Harness events into visible progress and a collapsible completed record. */
export function updateTerminalActivity(payload: Record<string, unknown>, event: AgentEventV1) {
  const activityLines = textLines(payload.activityLines);
  const resultLines = textLines(payload.resultLines);
  const eventLines = event.text?.split('\n').filter(Boolean) || [];
  const finished = ['completed', 'failed', 'cancelled'].includes(event.status);
  const activity = event.kind === 'activity'
    || (event.status === 'progress' && event.kind !== 'result');
  const nextActivityLines = activity
    ? [...activityLines, ...eventLines].slice(-100)
    : activityLines;
  const nextResultLines = event.kind === 'result'
    ? eventLines.slice(-40)
    : resultLines;
  return {
    activityLines: nextActivityLines,
    resultLines: finished && nextResultLines.length === 0 ? eventLines.slice(-40) : nextResultLines,
    activityCollapsed: finished
  };
}
