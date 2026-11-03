import { describe, expect, it } from 'vitest';
import {
  deleteWorkspaceNodes,
  duplicateWorkspaceNodes,
  nodesInLasso,
  nodesInMarquee,
  nudgeWorkspaceNodes,
  pasteWorkspaceNodes,
  readWorkspaceClipboard,
  writeWorkspaceClipboard
} from '../../lib/workspace/selection';
import type { WorkspaceDoc, WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, extra: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  w: 200,
  h: 150,
  z: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: {},
  ...extra
} as WorkspaceNode);

const doc = (nodes: WorkspaceNode[]): WorkspaceDoc => ({
  version: 1,
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  viewport: { x: 0, y: 0, zoom: 1 },
  nextZ: 5,
  nodes
} as WorkspaceDoc);

describe('duplicating a selection', () => {
  it('offsets the copy and puts it on top without touching the original', () => {
    const source = doc([node('a', { x: 100, y: 100 })]);
    const { doc: next, createdIds } = duplicateWorkspaceNodes(source, ['a']);
    const copy = next.nodes.find((n) => n.id === createdIds[0])!;

    expect(createdIds).toHaveLength(1);
    expect(copy.id).not.toBe('a');
    expect([copy.x, copy.y]).toEqual([128, 128]);
    expect(copy.z).toBeGreaterThan(source.nextZ - 1);
    expect(next.nodes.find((n) => n.id === 'a')).toEqual(source.nodes[0]);
  });

  it('carries a frame\'s members along and relinks them to the copied frame', () => {
    const source = doc([
      node('frame', { type: 'frame', w: 800, h: 600 }),
      node('member', { x: 50, y: 50, frameId: 'frame' })
    ]);
    const { doc: next, createdIds } = duplicateWorkspaceNodes(source, ['frame']);

    expect(createdIds).toHaveLength(2);
    const copiedFrame = next.nodes.find((n) => n.id === createdIds[0])!;
    const copiedMember = next.nodes.find((n) => n.id === createdIds[1])!;
    // The copy must belong to the new frame, not stay attached to the original.
    expect(copiedMember.frameId).toBe(copiedFrame.id);
  });

  it('preserves relative layout across a multi-node duplicate', () => {
    const source = doc([node('a', { x: 0, y: 0 }), node('b', { x: 300, y: 120 })]);
    const { doc: next, createdIds } = duplicateWorkspaceNodes(source, ['a', 'b']);
    const [first, second] = createdIds.map((id) => next.nodes.find((n) => n.id === id)!);

    expect(second.x - first.x).toBe(300);
    expect(second.y - first.y).toBe(120);
  });

  it('gives a duplicated terminal its own session instead of sharing the pty', () => {
    const source = doc([node('t', { type: 'terminal', payload: { sessionId: 'session-1' } })]);
    const { doc: next, createdIds } = duplicateWorkspaceNodes(source, ['t']);
    const copy = next.nodes.find((n) => n.id === createdIds[0])!;

    expect(copy.payload.sessionId).toBeTruthy();
    expect(copy.payload.sessionId).not.toBe('session-1');
  });

  it('does not let a duplicated run claim the original run\'s receipt', () => {
    const source = doc([node('r', {
      type: 'run',
      payload: { runId: 'run-1', receiptPath: '/receipts/run-1.json', status: 'completed', boardTaskId: 'task-9' }
    })]);
    const { doc: next, createdIds } = duplicateWorkspaceNodes(source, ['r']);
    const copy = next.nodes.find((n) => n.id === createdIds[0])!;

    expect(copy.payload.runId).toBeUndefined();
    expect(copy.payload.receiptPath).toBeUndefined();
    expect(copy.payload.boardTaskId).toBeUndefined();
    expect(copy.payload.status).toBe('waiting_approval');
  });
});

describe('deleting a selection', () => {
  it('removes every selected node at once', () => {
    const next = deleteWorkspaceNodes(doc([node('a'), node('b'), node('c')]), ['a', 'c']);
    expect(next.nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('releases a deleted scene\'s members rather than destroying the work inside', () => {
    const next = deleteWorkspaceNodes(
      doc([node('frame', { type: 'frame' }), node('member', { frameId: 'frame' })]),
      ['frame']
    );
    expect(next.nodes.map((n) => n.id)).toEqual(['member']);
    expect(next.nodes[0].frameId).toBeUndefined();
  });
});

describe('nudging a selection', () => {
  it('moves every selected node by the same step', () => {
    const next = nudgeWorkspaceNodes(doc([node('a'), node('b', { x: 50 })]), ['a', 'b'], 10, -10);
    expect(next.nodes.map((n) => [n.x, n.y])).toEqual([[10, -10], [60, -10]]);
  });

  it('carries frame members so a nudged scene stays rigid', () => {
    const next = nudgeWorkspaceNodes(
      doc([node('frame', { type: 'frame' }), node('member', { x: 20, frameId: 'frame' })]),
      ['frame'],
      5,
      0
    );
    expect(next.nodes.map((n) => n.x)).toEqual([5, 25]);
  });
});

describe('marquee selection', () => {
  const board = [node('hit', { x: 100, y: 100 }), node('miss', { x: 5_000, y: 5_000 })];

  it('selects nodes the box crosses, not only ones it fully contains', () => {
    // The box clips the corner of "hit" without enclosing it.
    expect(nodesInMarquee(board, { x: 0, y: 0, w: 150, h: 150 })).toEqual(['hit']);
  });

  it('works when dragged up and to the left', () => {
    expect(nodesInMarquee(board, { x: 250, y: 250, w: -200, h: -200 })).toEqual(['hit']);
  });

  it('leaves scenes out so a marquee never selects the container', () => {
    expect(nodesInMarquee([node('frame', { type: 'frame' })], { x: -10, y: -10, w: 999, h: 999 })).toEqual([]);
  });
});

describe('lasso selection', () => {
  // A square loop from (0,0) to (400,400).
  const loop = [0, 0, 400, 0, 400, 400, 0, 400];

  it('catches a node whose center is inside the loop', () => {
    expect(nodesInLasso([node('in', { x: 100, y: 100 })], loop)).toEqual(['in']);
  });

  it('leaves out a node the loop was drawn around but not over', () => {
    expect(nodesInLasso([node('out', { x: 1_000, y: 1_000 })], loop)).toEqual([]);
  });

  it('goes by the node center, so a corner grazing the loop is not enough', () => {
    // Spans x 300..500; its center at 400 sits on the boundary, body mostly out.
    expect(nodesInLasso([node('edge', { x: 300, y: 100, w: 200, h: 100 })], loop)).toEqual([]);
  });

  it('handles a concave loop, selecting only what is really enclosed', () => {
    // A C-shape: the notch on the right is outside the polygon.
    const cShape = [0, 0, 400, 0, 400, 100, 200, 100, 200, 300, 400, 300, 400, 400, 0, 400];
    const inNotch = node('notch', { x: 250, y: 150, w: 100, h: 100 }); // center (300,200)
    const inArm = node('arm', { x: 50, y: 150, w: 100, h: 100 }); // center (100,200)

    expect(nodesInLasso([inNotch, inArm], cShape)).toEqual(['arm']);
  });

  it('ignores a path too short to enclose anything', () => {
    expect(nodesInLasso([node('a')], [0, 0, 10, 10])).toEqual([]);
  });

  it('leaves scenes out, matching marquee behaviour', () => {
    expect(nodesInLasso([node('frame', { type: 'frame', x: 100, y: 100 })], loop)).toEqual([]);
  });
});

describe('workspace clipboard', () => {
  it('round-trips a selection through clipboard text', () => {
    const source = doc([node('a', { x: 10, y: 20 }), node('b')]);
    const parsed = readWorkspaceClipboard(writeWorkspaceClipboard(source, ['a']));

    expect(parsed).toHaveLength(1);
    expect(parsed![0].id).toBe('a');
  });

  it('treats ordinary copied text as text, not as nodes', () => {
    expect(readWorkspaceClipboard('just some notes I copied from a webpage')).toBeNull();
    expect(readWorkspaceClipboard('{"marker":"something-else","nodes":[]}')).toBeNull();
    expect(readWorkspaceClipboard('{ broken json')).toBeNull();
  });

  it('pastes at the cursor while preserving relative layout, with fresh ids', () => {
    const source = doc([node('a', { x: 1_000, y: 1_000 }), node('b', { x: 1_300, y: 1_120 })]);
    const copied = readWorkspaceClipboard(writeWorkspaceClipboard(source, ['a', 'b']))!;
    const { doc: next, createdIds } = pasteWorkspaceNodes(doc([]), copied, { x: 0, y: 0 });

    expect(createdIds).toHaveLength(2);
    expect(next.nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [300, 120]]);
    expect(createdIds).not.toContain('a');
  });
});
