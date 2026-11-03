import { describe, expect, it } from 'vitest';
import { rebindPendingWorkspaceContext } from '../../lib/workspace/pending-context';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(
  id: string,
  type: WorkspaceNode['type'],
  payload: Record<string, unknown>,
  parentId?: string
): WorkspaceNode {
  return {
    id,
    type,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 1,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    object: {
      kind: type === 'run' ? 'run' : type === 'intent' ? 'intent' : 'asset',
      status: type === 'run' ? 'waiting_approval' : 'ready',
      parentId
    },
    payload
  };
}

describe('pending HII run context rebinding', () => {
  it('refreshes a pending run and its intent when human focus changes', () => {
    const original = {
      id: 'source',
      title: 'Reference',
      type: 'image',
      anchor: { kind: 'image-region', x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    };
    const intent = node('intent', 'intent', { context: [original] });
    const run = node('run', 'run', {
      status: 'waiting_approval',
      context: [original],
      contextPreview: { fingerprint: 'old' }
    }, 'intent');
    const changed = {
      ...original,
      anchor: { kind: 'image-region', x: 0.3, y: 0.2, width: 0.4, height: 0.3 }
    };
    const updatedAt = '2026-07-30T01:00:00.000Z';

    const result = rebindPendingWorkspaceContext(
      [node('source', 'image', {}), intent, run],
      'source',
      changed,
      updatedAt
    );

    expect(result[1].payload.context).toEqual([changed]);
    expect(result[2].payload).toMatchObject({
      context: [changed],
      contextPreview: null,
      contextSyncedAt: updatedAt
    });
  });

  it('does not rewrite queued, completed, or unrelated runs', () => {
    const source = { id: 'source', title: 'Reference', type: 'image' };
    const queued = node('queued', 'run', { status: 'queued', context: [source] });
    const completed = node('completed', 'run', { status: 'completed', context: [source] });
    const unrelated = node('unrelated', 'run', {
      status: 'waiting_approval',
      context: [{ id: 'other', title: 'Other', type: 'file' }]
    });

    const result = rebindPendingWorkspaceContext(
      [queued, completed, unrelated],
      'source',
      { ...source, anchor: { kind: 'image-region', x: 0, y: 0, width: 1, height: 1 } },
      '2026-07-30T01:00:00.000Z'
    );

    expect(result).toEqual([queued, completed, unrelated]);
  });
});
