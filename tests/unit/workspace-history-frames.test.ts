import { describe, expect, it } from 'vitest';
import { assignNodesToFrame, moveNodeAndFrameContents, removeFrame } from '../../lib/workspace/frames';
import { emptyWorkspaceHistory, recordWorkspaceChange, redoWorkspace, undoWorkspace } from '../../lib/workspace/history';
import { emptyWorkspace, normalizeWorkspace, type WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, type: WorkspaceNode['type'], x: number, y: number, w = 100, h = 100): WorkspaceNode => ({
  id, type, x, y, w, h, z: 1, createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z', payload: {}
});

describe('workspace undo and frames', () => {
  it('restores a deleted node and redoes deletion without rolling back the persisted revision', () => {
    const original = { ...emptyWorkspace(), revision: 7, nodes: [node('note-1', 'note', 20, 20)] };
    const history = recordWorkspaceChange(emptyWorkspaceHistory(), original);
    const deleted = { ...original, revision: 8, nodes: [] };
    const undone = undoWorkspace(history, deleted);
    expect(undone?.doc.nodes.map((item) => item.id)).toEqual(['note-1']);
    expect(undone?.doc.revision).toBe(8);
    const redone = redoWorkspace(undone!.history, undone!.doc);
    expect(redone?.doc.nodes).toEqual([]);
    expect(redone?.doc.revision).toBe(8);
  });

  it('assigns contained objects to a frame and moves them as one unit', () => {
    const doc = { ...emptyWorkspace(), nodes: [
      node('frame-1', 'frame', 0, 0, 400, 300),
      node('inside', 'note', 40, 50),
      node('outside', 'image', 500, 500)
    ] };
    const grouped = assignNodesToFrame(doc, 'frame-1');
    expect(grouped.nodes.find((item) => item.id === 'inside')?.frameId).toBe('frame-1');
    expect(grouped.nodes.find((item) => item.id === 'outside')?.frameId).toBeUndefined();
    const moved = moveNodeAndFrameContents(grouped, 'frame-1', 100, 80);
    expect(moved.nodes.find((item) => item.id === 'inside')).toMatchObject({ x: 140, y: 130 });
    expect(moved.nodes.find((item) => item.id === 'outside')).toMatchObject({ x: 500, y: 500 });
  });

  it('removes a frame without deleting its contents', () => {
    const doc = { ...emptyWorkspace(), nodes: [
      node('frame-1', 'frame', 0, 0),
      { ...node('inside', 'note', 20, 20), frameId: 'frame-1' }
    ] };
    const unframed = removeFrame(doc, 'frame-1');
    expect(unframed.nodes.map((item) => item.id)).toEqual(['inside']);
    expect(unframed.nodes[0].frameId).toBeUndefined();
  });

  it('normalizes persisted frame membership as a first-class workspace relationship', () => {
    const normalized = normalizeWorkspace({
      ...emptyWorkspace(),
      nodes: [
        node('frame-1', 'frame', 0, 0),
        { ...node('inside', 'note', 20, 20), frameId: 'frame-1' }
      ]
    });
    expect(normalized.nodes[0].type).toBe('frame');
    expect(normalized.nodes[1].frameId).toBe('frame-1');
  });
});
