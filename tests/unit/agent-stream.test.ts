import { describe, expect, it } from 'vitest';
import { mergeAgentResponse } from '../../lib/workspace/agent-stream';
import type { AgentEventV1 } from '../../lib/client/hii-bridge';

const event = (patch: Partial<AgentEventV1>): AgentEventV1 => ({
  version: 1,
  runId: 'run-1',
  status: 'progress',
  ...patch
});

describe('direct agent response stream', () => {
  it('preserves model delta whitespace exactly', () => {
    expect(mergeAgentResponse('Hello', event({ kind: 'delta', text: ' world' }))).toBe('Hello world');
  });

  it('keeps tool and completion status outside the model response', () => {
    expect(mergeAgentResponse('Answer', event({ kind: 'activity', text: 'web_fetch · source' }))).toBe('Answer');
    expect(mergeAgentResponse('Answer', event({ kind: 'status', status: 'completed', text: 'Agent work completed.' }))).toBe('Answer');
  });

  it('uses a final summary only when no direct stream arrived', () => {
    expect(mergeAgentResponse('', event({ kind: 'summary', text: 'Fallback result' }))).toBe('Fallback result');
    expect(mergeAgentResponse('Streamed result', event({ kind: 'summary', text: 'Fallback result' }))).toBe('Streamed result');
  });
});
