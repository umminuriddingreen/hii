import { describe, expect, it } from 'vitest';
import {
  adjacentWorkspaceScene,
  workspaceSceneMembers,
  workspaceScenes,
  workspaceSceneTypeSummary
} from '../../lib/workspace/scenes';
import type { WorkspaceNode } from '../../lib/workspace/types';

const node = (
  id: string,
  type: WorkspaceNode['type'],
  createdAt: string,
  payload: Record<string, unknown> = {}
): WorkspaceNode => ({
  id,
  type,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 1,
  createdAt,
  updatedAt: createdAt,
  payload
});

describe('workspace scenes', () => {
  const first = node('scene-a', 'frame', '2026-07-30T00:00:00.000Z', { sceneOrder: 2 });
  const second = node('scene-b', 'frame', '2026-07-30T00:01:00.000Z', { sceneOrder: 1 });
  const legacy = node('scene-c', 'frame', '2026-07-30T00:02:00.000Z');
  const note = { ...node('note-a', 'note', '2026-07-30T00:03:00.000Z'), frameId: first.id };

  it('orders explicit scenes before legacy frames without losing compatibility', () => {
    expect(workspaceScenes([first, note, legacy, second]).map((scene) => scene.id)).toEqual([
      'scene-b',
      'scene-a',
      'scene-c'
    ]);
  });

  it('navigates scenes as a wrapping sequence', () => {
    const scenes = workspaceScenes([first, second, legacy]);
    expect(adjacentWorkspaceScene(scenes, null, 1)?.id).toBe('scene-b');
    expect(adjacentWorkspaceScene(scenes, 'scene-c', 1)?.id).toBe('scene-b');
    expect(adjacentWorkspaceScene(scenes, 'scene-b', -1)?.id).toBe('scene-c');
  });

  it('reports explicit membership and a compact type summary', () => {
    const image = { ...node('image-a', 'image', '2026-07-30T00:04:00.000Z'), frameId: first.id };
    const other = { ...node('note-b', 'note', '2026-07-30T00:05:00.000Z'), frameId: second.id };
    const members = workspaceSceneMembers([first, note, image, other], first.id);
    expect(members.map((member) => member.id)).toEqual(['note-a', 'image-a']);
    expect(workspaceSceneTypeSummary(members)).toBe('1 image · 1 note');
    expect(workspaceSceneTypeSummary([])).toBe('empty scene');
  });
});
