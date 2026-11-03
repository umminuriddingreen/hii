import { describe, expect, it } from 'vitest';
import { alignWorkspaceNodes, distributeWorkspaceNodes, snapWorkspaceRect } from '../../lib/workspace/snap';
import type { WorkspaceNode } from '../../lib/workspace/types';

const node = (id: string, x: number, y: number, w = 200, h = 100): WorkspaceNode => ({
  id,
  type: 'note',
  x,
  y,
  w,
  h,
  z: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: {}
} as WorkspaceNode);

describe('drag snapping', () => {
  const neighbour = node('fixed', 400, 400);

  it('pulls a nearly aligned edge into exact alignment', () => {
    const result = snapWorkspaceRect({ x: 397, y: 700, w: 200, h: 100 }, [neighbour]);
    expect(result.x).toBe(400);
    expect(result.guides.some((guide) => guide.axis === 'x' && guide.position === 400)).toBe(true);
  });

  it('snaps centers, not just edges', () => {
    // Dragged center at 498 against the neighbour's center at 500.
    const result = snapWorkspaceRect({ x: 398, y: 900, w: 200, h: 100 }, [neighbour]);
    expect(result.x + 100).toBe(500);
  });

  it('leaves a clearly unaligned node exactly where it was', () => {
    const result = snapWorkspaceRect({ x: 137, y: 762, w: 200, h: 100 }, [neighbour]);
    expect([result.x, result.y]).toEqual([137, 762]);
    expect(result.guides).toEqual([]);
  });

  it('keeps the snap radius constant on screen as the board zooms', () => {
    // 20 workspace units off. At zoom 1 that is 20px away — too far to snap.
    expect(snapWorkspaceRect({ x: 380, y: 700, w: 200, h: 100 }, [neighbour], 1).x).toBe(380);
    // Zoomed out to 0.2 the same gap is only 4px on screen, so it should snap.
    expect(snapWorkspaceRect({ x: 380, y: 700, w: 200, h: 100 }, [neighbour], 0.2).x).toBe(400);
  });

  it('takes the nearest alignment when several are in range', () => {
    const result = snapWorkspaceRect({ x: 398, y: 700, w: 200, h: 100 }, [neighbour, node('other', 402, 400)]);
    expect(result.x).toBe(400);
  });

  it('draws a guide spanning both nodes so the alignment is legible', () => {
    const result = snapWorkspaceRect({ x: 397, y: 700, w: 200, h: 100 }, [neighbour]);
    const guide = result.guides.find((candidate) => candidate.axis === 'x')!;
    expect(guide.from).toBe(400);
    expect(guide.to).toBe(800);
  });
});

describe('align and distribute', () => {
  it('aligns to the outermost edge of the selection', () => {
    const moves = alignWorkspaceNodes([node('a', 100, 0), node('b', 300, 0), node('c', 500, 0)], 'left');
    expect(moves.get('b')?.x).toBe(100);
    expect(moves.get('c')?.x).toBe(100);
    expect(moves.has('a')).toBe(false); // already there, so not moved
  });

  it('aligns right edges by accounting for differing widths', () => {
    const moves = alignWorkspaceNodes([node('wide', 0, 0, 400), node('narrow', 0, 200, 100)], 'right');
    expect(moves.get('narrow')?.x).toBe(300);
  });

  it('needs at least two nodes to mean anything', () => {
    expect(alignWorkspaceNodes([node('a', 100, 0)], 'left').size).toBe(0);
  });

  it('evens out gaps while leaving the outermost nodes anchored', () => {
    const moves = distributeWorkspaceNodes(
      [node('a', 0, 0, 100), node('b', 150, 0, 100), node('c', 700, 0, 100)],
      'x'
    );
    expect(moves.has('a')).toBe(false);
    expect(moves.has('c')).toBe(false);
    // Span 800, 300 occupied, 500 of gap across two gaps => b starts at 100+250.
    expect(moves.get('b')?.x).toBe(350);
  });

  it('needs three nodes before distribution is meaningful', () => {
    expect(distributeWorkspaceNodes([node('a', 0, 0), node('b', 400, 0)], 'x').size).toBe(0);
  });
});
