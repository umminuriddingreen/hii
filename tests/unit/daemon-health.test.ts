import { describe, expect, it } from 'vitest';
import { summarizeHiiDaemonHealth } from '@/lib/workspace/daemon-health';

const now = Date.parse('2026-07-30T15:00:00.000Z');
const readyInput = {
  alive: true,
  status: { updatedAt: '2026-07-30T14:59:57.000Z' },
  instances: [
    { owned: true, status: 'running', type: 'agent' },
    ...Array.from({ length: 31 }, () => ({ owned: false, status: 'running', type: 'process' })),
    ...Array.from({ length: 12 }, () => ({ owned: true, status: 'completed', type: 'codex-run' }))
  ],
  runs: [],
  workspaceJobs: [],
  events: [],
  now
};

describe('operator-meaningful AII health', () => {
  it('does not mistake observed processes or historical runs for active agents', () => {
    const health = summarizeHiiDaemonHealth(readyInput);
    expect(health.state).toBe('ready');
    expect(health.label).toBe('AII ready');
    expect(health.activeRuns).toBe(0);
    expect(health.ownedServices).toBe(1);
    expect(health.observedProcesses).toBe(31);
  });

  it('shows active approved work without treating it as degraded health', () => {
    const health = summarizeHiiDaemonHealth({
      ...readyInput,
      runs: [{ status: 'running' }],
      workspaceJobs: [{ status: 'queued' }]
    });
    expect(health.state).toBe('busy');
    expect(health.label).toBe('AII working');
    expect(health.recoveryAction).toBeNull();
  });

  it('offers a restart only for stale or recently failing runtime state', () => {
    const stale = summarizeHiiDaemonHealth({
      ...readyInput,
      status: { updatedAt: '2026-07-30T14:58:00.000Z' }
    });
    expect(stale.state).toBe('attention');
    expect(stale.recoveryAction).toBe('restart');

    const failed = summarizeHiiDaemonHealth({
      ...readyInput,
      events: [{ type: 'daemon.error', ts: '2026-07-30T14:59:45.000Z', text: 'intent loop failed' }]
    });
    expect(failed.state).toBe('attention');
    expect(failed.summary).toContain('intent loop failed');
  });

  it('offers start when AII is offline', () => {
    const health = summarizeHiiDaemonHealth({ ...readyInput, alive: false });
    expect(health.state).toBe('offline');
    expect(health.label).toBe('AII offline');
    expect(health.recoveryAction).toBe('start');
  });
});
