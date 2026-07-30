import { describe, expect, it } from 'vitest';
import {
  workspaceFlattenOutlineEntries,
  workspaceOutlineEntryCount,
  workspaceOutlineGroups
} from '../../lib/workspace/outline';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(
  id: string,
  type: WorkspaceNode['type'],
  options: {
    title?: string;
    frameId?: string;
    parentId?: string;
    status?: string;
    x?: number;
    y?: number;
    sceneOrder?: number;
  } = {}
): WorkspaceNode {
  return {
    id,
    type,
    x: options.x ?? 0,
    y: options.y ?? 0,
    w: 100,
    h: 100,
    z: 1,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    frameId: options.frameId,
    object: {
      kind: type === 'frame' ? 'scene' : type,
      parentId: options.parentId
    },
    payload: {
      title: options.title ?? id,
      sceneOrder: options.sceneOrder,
      status: options.status
    }
  };
}

describe('governed workspace outline', () => {
  it('groups every object into an ordered scene or the loose-object group', () => {
    const scene = node('scene', 'frame', { title: 'Launch', sceneOrder: 1 });
    const intent = node('intent', 'intent', { title: 'Ship launch', frameId: scene.id, y: 10 });
    const run = node('run', 'run', {
      title: 'Bounded launch run',
      frameId: scene.id,
      parentId: intent.id,
      status: 'waiting_approval',
      y: 20
    });
    const receipt = node('receipt', 'note', {
      title: 'Run receipt',
      frameId: scene.id,
      parentId: run.id,
      status: 'completed',
      y: 30
    });
    const loose = node('reference', 'image', { title: 'Reference', x: 900 });

    const groups = workspaceOutlineGroups([loose, receipt, run, scene, intent]);
    expect(groups.map((group) => group.title)).toEqual(['Launch', 'Loose objects']);
    expect(groups[0].memberCount).toBe(3);
    expect(workspaceOutlineEntryCount(groups[0].entries)).toBe(3);
    expect(workspaceFlattenOutlineEntries(groups[0].entries).map((entry) => [
      entry.node.id,
      entry.depth
    ])).toEqual([
      ['intent', 0],
      ['run', 1],
      ['receipt', 2]
    ]);
    expect(groups[0].statusCounts).toEqual([
      ['completed', 1],
      ['waiting approval', 1]
    ]);
    expect(groups[1].entries[0].node.id).toBe('reference');
  });

  it('keeps ancestors when a governed descendant matches search', () => {
    const intent = node('intent', 'intent', { title: 'Campaign direction' });
    const run = node('run', 'run', { title: 'Generate options', parentId: intent.id });
    const receipt = node('receipt', 'note', {
      title: 'Verified campaign receipt',
      parentId: run.id,
      status: 'completed'
    });

    const groups = workspaceOutlineGroups([intent, run, receipt], 'verified receipt');
    const rows = workspaceFlattenOutlineEntries(groups[0].entries);
    expect(rows.map((entry) => entry.node.id)).toEqual(['intent', 'run', 'receipt']);
  });

  it('fails open as navigable roots for missing parents and parent cycles', () => {
    const missing = node('missing-child', 'note', { parentId: 'not-here' });
    const first = node('first', 'intent', { parentId: 'second' });
    const second = node('second', 'run', { parentId: 'first' });

    const rows = workspaceFlattenOutlineEntries(workspaceOutlineGroups([missing, first, second])[0].entries);
    expect(new Set(rows.map((entry) => entry.node.id))).toEqual(new Set(['missing-child', 'first', 'second']));
  });
});
