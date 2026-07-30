import { describe, expect, it } from 'vitest';
import { terminalRunMessage, workspaceRunEvidence, workspaceRunProgress } from '../../lib/workspace/run-progress';

describe('governed workspace run progress', () => {
  it('turns a completed job into a receipt-first lifecycle', () => {
    const job = {
      status: 'completed',
      createdAt: '2026-07-30T12:00:00.000Z',
      updatedAt: '2026-07-30T12:01:05.000Z',
      metadata: { startedAt: '2026-07-30T12:00:05.000Z', workspaceRoot: '/tmp/hii-project' },
      logs: ['raw tool transcript'],
      ledger: [{ type: 'approval', summary: 'Approved 2 canvas objects.', createdAt: '2026-07-30T12:00:00.000Z' }],
      proofArtifacts: [{ kind: 'receipt', label: 'HII receipt', path: '/tmp/receipt.json' }]
    };
    const receipt = {
      summary: 'Created and verified the requested artifact.',
      verification: [{ command: 'npm test', ok: true }],
      artifacts: ['result.md']
    };

    const steps = workspaceRunProgress({ status: 'completed', contextCount: 2, maxSteps: 8, job, receipt });
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(steps[0].detail).toBe('Approved 2 canvas objects.');
    expect(steps[2].detail).toContain('1m');
    expect(steps[4].detail).toBe(receipt.summary);
  });

  it('keeps raw logs out of the default progress language', () => {
    const job = {
      status: 'running',
      logs: ['secret-looking raw output that belongs in evidence'],
      ledger: [{ type: 'approval', summary: 'Approved local work.' }],
      proofArtifacts: []
    };

    const steps = workspaceRunProgress({ status: 'running', job, workspaceRoot: '/tmp/work' });
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'current', 'pending', 'pending']);
    expect(JSON.stringify(steps)).not.toContain(job.logs[0]);
    expect(workspaceRunEvidence(job, null).logs).toEqual(job.logs);
  });

  it('marks a terminal run without proof as needing attention', () => {
    const steps = workspaceRunProgress({ status: 'failed', job: { status: 'failed', logs: ['raw failure'] } });
    expect(steps.find((step) => step.id === 'work')?.state).toBe('attention');
    expect(steps.find((step) => step.id === 'proof')?.state).toBe('attention');
    expect(steps.find((step) => step.id === 'receipt')?.detail).toBe('No verified receipt was returned.');
  });

  it('keeps terminal summaries human-readable while raw output stays in evidence', () => {
    const rawFailure = '[2026-07-30T13:57:17.727Z] Command failed: hii run';
    expect(terminalRunMessage('failed')).not.toContain(rawFailure);
    expect(terminalRunMessage('failed')).toBe(
      'AII recorded this bounded run as failed. Inspect its evidence for the final execution output.'
    );
    expect(terminalRunMessage('cancelled')).toBe('AII stopped this bounded run. Its approval is closed.');
    expect(workspaceRunEvidence({ logs: [rawFailure] }, null).logs).toEqual([rawFailure]);
  });
});
