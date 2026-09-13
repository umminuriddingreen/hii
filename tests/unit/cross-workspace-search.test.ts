import { describe, expect, it } from 'vitest';
import { searchCanvasWorkspaces } from '../../lib/workspace/cross-workspace-search';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(id: string, title: string): WorkspaceNode {
  return { id, type: 'note', x: 0, y: 0, w: 100, h: 100, z: 1,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', payload: { title } } as WorkspaceNode;
}

describe('cross-workspace canvas search', () => {
  it('finds objects in every supplied workspace with their origin', () => {
    const results = searchCanvasWorkspaces([
      { id: 'a', title: 'Architecture', nodes: [node('one', 'Facade detail')] },
      { id: 'b', title: 'Research', nodes: [node('two', 'Facade study')] }
    ], 'facade');
    expect(results.map(({ workspaceId, node: item }) => [workspaceId, item.id])).toEqual([['a', 'one'], ['b', 'two']]);
  });

  it('does not search absent workspaces or return results for an empty query', () => {
    expect(searchCanvasWorkspaces([{ id: 'a', title: 'A', nodes: [node('one', 'Facade')] }], 'other')).toEqual([]);
    expect(searchCanvasWorkspaces([{ id: 'a', title: 'A', nodes: [node('one', 'Facade')] }], ' ')).toEqual([]);
  });
});
