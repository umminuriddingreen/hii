import { describe, expect, it } from 'vitest';
import { interpretCanvasIntent } from '../../lib/workspace/canvas-intent';
import type { WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, title: string): WorkspaceNode => ({
  id, type: 'note', x: 0, y: 0, w: 200, h: 120, z: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', payload: { title }
} as WorkspaceNode);
const nodes = [node('a', 'Project brief'), node('b', 'Budget notes'), node('c', 'Project archive')];
const context = { nodes, selectedIds: ['b'], visibleIds: ['a', 'b'] };

describe('conversational canvas intents', () => {
  it('keeps destructive language grounded in the current selection', () => {
    expect(interpretCanvasIntent('clear this', context)).toEqual({ kind: 'delete', targetIds: ['b'] });
    expect(interpretCanvasIntent('delete this', { ...context, selectedIds: [] })).toEqual({
      kind: 'clarify', message: 'Select what to delete, or say “delete everything visible”.'
    });
  });

  it('can explicitly operate on what is visible', () => {
    expect(interpretCanvasIntent('tidy everything visible', context)).toEqual({ kind: 'tidy', targetIds: ['a', 'b'] });
  });

  it('moves and duplicates the selection', () => {
    expect(interpretCanvasIntent('move these left', context)).toEqual({ kind: 'move', targetIds: ['b'], dx: -40, dy: 0 });
    expect(interpretCanvasIntent('duplicate the selection', context)).toEqual({ kind: 'duplicate', targetIds: ['b'] });
  });

  it('grounds non-destructive pronouns in the viewport when nothing is selected', () => {
    expect(interpretCanvasIntent('move these down', { ...context, selectedIds: [] })).toEqual({
      kind: 'move', targetIds: ['a', 'b'], dx: 0, dy: 40
    });
  });

  it('fits the workspace and focuses nodes by title, preferring a visible match', () => {
    expect(interpretCanvasIntent('show all', context)).toEqual({ kind: 'fit-all' });
    expect(interpretCanvasIntent('open project', context)).toEqual({ kind: 'focus', nodeId: 'a' });
  });

  it('leaves unrelated requests for the agent intent flow', () => {
    expect(interpretCanvasIntent('research resilient local storage', context)).toBeNull();
  });
});
