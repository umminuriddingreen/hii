import { describe, expect, it } from 'vitest';
import { emptyWorkspaceHistory, recordWorkspaceChange, undoWorkspace } from '../../lib/workspace/history';
import { organizeWorkspaceSelection } from '../../lib/workspace/organize';
import { workspaceOutlineGroups } from '../../lib/workspace/outline';
import type { WorkspaceDoc, WorkspaceNode } from '../../lib/workspace/types';

function node(id: string, x: number, y: number, type: WorkspaceNode['type'] = 'image'): WorkspaceNode {
  return {
    id,
    type,
    x,
    y,
    w: 100,
    h: 80,
    z: Number(id.replace(/\D/g, '')) || 1,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    object: { kind: type === 'image' ? 'asset' : 'note', owner: 'human', status: 'ready' },
    payload: { title: id, url: `/assets/${id}.png` }
  };
}

function document(nodes: WorkspaceNode[]): WorkspaceDoc {
  return {
    version: 1,
    revision: 7,
    updatedAt: '2026-07-30T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 300,
    nodes
  };
}

describe('explicit workspace selection organization', () => {
  it('creates a human-owned Scene around exact selected objects without moving or flattening them', () => {
    const first = node('image-1', 100, 200);
    const second = node('image-2', 420, 360);
    const untouched = node('note-3', 220, 260, 'note');
    const before = document([first, second, untouched]);
    const result = organizeWorkspaceSelection(before, [second.id, first.id], {
      sceneId: 'scene-explicit',
      title: 'Material references',
      now: '2026-07-30T12:00:00.000Z'
    });

    expect(result).not.toBeNull();
    expect(result?.scene).toMatchObject({
      id: 'scene-explicit',
      type: 'frame',
      x: 68,
      y: 144,
      w: 484,
      h: 328,
      object: {
        kind: 'scene',
        owner: 'human',
        status: 'ready',
        capabilityId: 'hii.workspace.creative_canvas'
      },
      payload: {
        title: 'Material references',
        membership: 'explicit-selection',
        memberCount: 2
      }
    });
    expect(result?.organizedIds).toEqual(['image-1', 'image-2']);
    expect(result?.doc.nodes.filter((item) => item.frameId === 'scene-explicit').map((item) => item.id)).toEqual([
      'image-1',
      'image-2'
    ]);
    expect(result?.doc.nodes.find((item) => item.id === untouched.id)?.frameId).toBeUndefined();
    expect(result?.doc.nodes.find((item) => item.id === first.id)).toMatchObject({
      x: first.x,
      y: first.y,
      w: first.w,
      h: first.h,
      payload: first.payload,
      object: first.object
    });
  });

  it('is one-step reversible through the existing workspace history contract', () => {
    const before = document([node('image-1', 0, 0), node('image-2', 160, 0)]);
    const organized = organizeWorkspaceSelection(before, ['image-1', 'image-2'], {
      sceneId: 'scene-reversible',
      now: '2026-07-30T12:00:00.000Z'
    });
    const history = recordWorkspaceChange(emptyWorkspaceHistory(), before);
    const undone = organized ? undoWorkspace(history, organized.doc) : null;

    expect(undone?.doc.nodes).toEqual(before.nodes);
    expect(undone?.doc.revision).toBe(before.revision);
  });

  it('keeps hundreds of objects navigable as one governed Scene without dropping lineage', () => {
    const nodes = Array.from({ length: 240 }, (_, index) =>
      node(`image-${index + 1}`, (index % 20) * 120, Math.floor(index / 20) * 100)
    );
    const before = document(nodes);
    const organized = organizeWorkspaceSelection(before, nodes.map((item) => item.id), {
      sceneId: 'scene-scale-proof',
      title: '240 reference study',
      now: '2026-07-30T12:00:00.000Z'
    });

    expect(organized?.organizedIds).toHaveLength(240);
    expect(organized?.doc.nodes).toHaveLength(241);
    const outline = organized ? workspaceOutlineGroups(organized.doc.nodes) : [];
    expect(outline).toHaveLength(1);
    expect(outline[0]).toMatchObject({
      id: 'scene-scale-proof',
      title: '240 reference study',
      memberCount: 240,
      statusCounts: [['ready', 240]]
    });
  });

  it('refuses single objects and ignores selected frame nodes', () => {
    const image = node('image-1', 0, 0);
    const frame = { ...node('frame-2', 0, 0, 'frame'), object: { kind: 'scene' as const } };
    expect(organizeWorkspaceSelection(document([image]), [image.id])).toBeNull();
    expect(organizeWorkspaceSelection(document([image, frame]), [image.id, frame.id])).toBeNull();
  });

  it('keeps Scene sequence monotonic when earlier Scenes were removed', () => {
    const existing = {
      ...node('frame-9', 0, 0, 'frame'),
      object: { kind: 'scene' as const, owner: 'human' as const },
      payload: { title: 'Existing Scene', sceneOrder: 9 }
    };
    const organized = organizeWorkspaceSelection(
      document([existing, node('image-1', 0, 0), node('image-2', 160, 0)]),
      ['image-1', 'image-2'],
      { sceneId: 'scene-next', now: '2026-07-30T12:00:00.000Z' }
    );

    expect(organized?.scene.payload.sceneOrder).toBe(10);
    expect(organized?.scene.payload.title).toBe('Scene 10');
  });
});
