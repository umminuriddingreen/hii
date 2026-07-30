import { describe, expect, it } from 'vitest';
import {
  buildLaunchProofWorkspace,
  launchProofGoal,
  launchStoryboardContent,
  launchStoryboardPath
} from '../../lib/workspace/launch-proof';

describe('launch proof workspace', () => {
  it('builds a seven-object workspace from a real completed run shape', () => {
    const run = {
      job: {
        id: 'launch-run',
        status: 'completed',
        logs: ['raw output'],
        ledger: [{ type: 'approval', summary: 'Approved 3 canvas context objects.' }],
        proofArtifacts: [{ kind: 'receipt', path: '/tmp/receipt.json', label: 'receipt' }],
        metadata: { model: 'qwen3.6:35b-mlx', maxSteps: 8 },
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:01:00.000Z'
      },
      path: '/tmp/receipt.json',
      receipt: {
        summary: 'Created and verified the launch storyboard.',
        artifacts: [launchStoryboardPath],
        verification: [{ command: 'verify storyboard', ok: true }]
      }
    };

    const workspace = buildLaunchProofWorkspace(run, { workspaceRoot: '/Users/ummi/hii' });
    expect(workspace.nodes).toHaveLength(7);
    expect(workspace.nodes.map((node) => node.object?.kind)).toEqual([
      'source',
      'source',
      'source',
      'intent',
      'run',
      'artifact',
      'receipt'
    ]);
    expect(workspace.nodes.find((node) => node.object?.kind === 'run')?.payload.status).toBe('completed');
    expect(workspace.nodes.find((node) => node.object?.kind === 'artifact')?.payload.artifactPath)
      .toBe(launchStoryboardPath);
    expect(workspace.nodes.find((node) => node.object?.kind === 'receipt')?.payload.checks).toHaveLength(1);
    expect(workspace.viewport.zoom).toBeGreaterThan(0);
    expect(launchProofGoal).toContain('Do not repeat either action');
    expect(launchStoryboardContent.match(/^## Beat [1-4]$/gm)).toHaveLength(4);
  });

  it('refuses to build a launch workspace without the receipt-named artifact', () => {
    expect(() => buildLaunchProofWorkspace({
      job: { id: 'missing-artifact', status: 'completed', metadata: {} },
      path: '/tmp/receipt.json',
      receipt: { artifacts: [], verification: [{ command: 'check', ok: true }] }
    }, { workspaceRoot: '/Users/ummi/hii' })).toThrow(`did not name ${launchStoryboardPath}`);
  });
});
