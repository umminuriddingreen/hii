import { describe, expect, it } from 'vitest';
import { workspaceConnections } from '../../lib/workspace/connections';
import type { WorkspaceNode } from '../../lib/workspace/types';

const base = {
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  z: 1,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  payload: {}
};

describe('workspace governed lineage', () => {
  it('connects selected context and parent lineage without inventing missing nodes', () => {
    const nodes: WorkspaceNode[] = [
      { ...base, id: 'source', type: 'image' },
      {
        ...base,
        id: 'intent',
        type: 'intent',
        x: 200,
        payload: { context: [{ id: 'source', title: 'Reference', type: 'image' }, { id: 'missing', title: 'Missing', type: 'file' }] }
      },
      {
        ...base,
        id: 'run',
        type: 'run',
        x: 400,
        object: { kind: 'run', parentId: 'intent' }
      },
      {
        ...base,
        id: 'receipt',
        type: 'note',
        x: 600,
        object: { kind: 'receipt', parentId: 'run' }
      }
    ];

    expect(workspaceConnections(nodes).map((connection) => [connection.kind, connection.fromId, connection.toId])).toEqual([
      ['context', 'source', 'intent'],
      ['lineage', 'intent', 'run'],
      ['lineage', 'run', 'receipt']
    ]);
  });
});
