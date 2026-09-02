import type { AgentEventV1 } from '@/lib/client/hii-bridge';

export function mergeAgentResponse(current: string, event: AgentEventV1) {
  const prior = current.trim() === 'Thinking…' ? '' : current;
  const text = event.text || '';

  if (event.kind === 'delta') return `${prior}${text}`;
  if (event.kind === 'summary') return prior || text;
  if (event.status === 'failed' || event.status === 'cancelled') {
    return text ? `${prior}${prior ? '\n\n' : ''}${text}` : prior;
  }
  if (event.kind === 'activity' || event.kind === 'status') return prior || 'Thinking…';
  return text ? `${prior}${prior ? '\n' : ''}${text}` : prior || 'Thinking…';
}
