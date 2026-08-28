import { describe, expect, it } from 'vitest';
import { updateTerminalActivity } from '../../lib/workspace/terminal-activity';

describe('agent terminal activity', () => {
  it('shows only the latest live activity while retaining a bounded history', () => {
    const state = updateTerminalActivity({ activityLines: ['Preparing work…'] }, {
      version: 1,
      runId: 'run-1',
      status: 'progress',
      kind: 'activity',
      text: 'filesystem.patch · workspace'
    });
    expect(state).toEqual({
      activityLines: ['Preparing work…', 'filesystem.patch · workspace'],
      resultLines: [],
      activityCollapsed: false
    });
  });

  it('preserves the result and collapses activity after completion', () => {
    const withResult = updateTerminalActivity({ activityLines: ['Located sources'] }, {
      version: 1,
      runId: 'run-1',
      status: 'progress',
      kind: 'result',
      text: 'Created three verified alternatives.'
    });
    const completed = updateTerminalActivity(withResult, {
      version: 1,
      runId: 'run-1',
      status: 'completed',
      kind: 'status',
      text: 'Agent work completed.'
    });
    expect(completed.activityCollapsed).toBe(true);
    expect(completed.activityLines).toEqual(['Located sources']);
    expect(completed.resultLines).toEqual(['Created three verified alternatives.']);
  });
});
