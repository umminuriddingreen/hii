import type { WorkspaceNode } from './types';

/** How close, in screen pixels, an edge must be before it snaps. */
export const SNAP_THRESHOLD = 6;
/** Nodes further than this from the dragged node are not considered. */
export const SNAP_NEIGHBOURHOOD = 1_200;

export type SnapRect = { x: number; y: number; w: number; h: number };
export type SnapGuide = { axis: 'x' | 'y'; position: number; from: number; to: number };
export type SnapResult = { x: number; y: number; guides: SnapGuide[] };

type Candidate = { offset: number; guide: SnapGuide };

/**
 * Align a dragged rect to its neighbours.
 *
 * Snapping is expressed in workspace units but thresholded in screen pixels, so
 * the gesture feels equally forgiving whether the board is zoomed right in or
 * all the way out.
 *
 * Guides describe the line to draw: the shared coordinate, and the span it
 * covers, so the overlay can bracket the two nodes being aligned rather than
 * drawing edge to edge across the whole canvas.
 */
export function snapWorkspaceRect(
  rect: SnapRect,
  others: WorkspaceNode[],
  zoom = 1,
  threshold = SNAP_THRESHOLD
): SnapResult {
  const tolerance = threshold / (zoom > 0 ? zoom : 1);
  const nearby = others.filter((node) =>
    Math.abs(node.x - rect.x) < SNAP_NEIGHBOURHOOD && Math.abs(node.y - rect.y) < SNAP_NEIGHBOURHOOD);

  const horizontal: Candidate[] = [];
  const vertical: Candidate[] = [];

  // Left/centre/right against left/centre/right, and the same for the vertical
  // axis. Nine pairings per axis is what makes edges *and* centres both snap.
  const edgesOf = (r: SnapRect) => ({
    x: [r.x, r.x + r.w / 2, r.x + r.w],
    y: [r.y, r.y + r.h / 2, r.y + r.h]
  });
  const moving = edgesOf(rect);

  for (const node of nearby) {
    const fixed = edgesOf(node);
    for (const movingEdge of moving.x) {
      for (const fixedEdge of fixed.x) {
        const distance = fixedEdge - movingEdge;
        if (Math.abs(distance) > tolerance) continue;
        horizontal.push({
          offset: distance,
          guide: {
            axis: 'x',
            position: fixedEdge,
            from: Math.min(rect.y, node.y),
            to: Math.max(rect.y + rect.h, node.y + node.h)
          }
        });
      }
    }
    for (const movingEdge of moving.y) {
      for (const fixedEdge of fixed.y) {
        const distance = fixedEdge - movingEdge;
        if (Math.abs(distance) > tolerance) continue;
        vertical.push({
          offset: distance,
          guide: {
            axis: 'y',
            position: fixedEdge,
            from: Math.min(rect.x, node.x),
            to: Math.max(rect.x + rect.w, node.x + node.w)
          }
        });
      }
    }
  }

  const best = (candidates: Candidate[]) =>
    candidates.reduce<Candidate | null>((winner, candidate) =>
      !winner || Math.abs(candidate.offset) < Math.abs(winner.offset) ? candidate : winner, null);

  const bestX = best(horizontal);
  const bestY = best(vertical);

  return {
    x: rect.x + (bestX?.offset ?? 0),
    y: rect.y + (bestY?.offset ?? 0),
    // Only guides on the winning offset are real; the rest were near misses.
    guides: [
      ...horizontal.filter((candidate) => bestX && candidate.offset === bestX.offset).map((candidate) => candidate.guide),
      ...vertical.filter((candidate) => bestY && candidate.offset === bestY.offset).map((candidate) => candidate.guide)
    ]
  };
}

export type AlignEdge = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom';

/** Align a set of nodes to a shared edge. Returns new positions by id. */
export function alignWorkspaceNodes(nodes: WorkspaceNode[], edge: AlignEdge): Map<string, { x: number; y: number }> {
  const moves = new Map<string, { x: number; y: number }>();
  if (nodes.length < 2) return moves;

  const left = Math.min(...nodes.map((node) => node.x));
  const right = Math.max(...nodes.map((node) => node.x + node.w));
  const top = Math.min(...nodes.map((node) => node.y));
  const bottom = Math.max(...nodes.map((node) => node.y + node.h));

  for (const node of nodes) {
    let { x, y } = node;
    if (edge === 'left') x = left;
    else if (edge === 'right') x = right - node.w;
    else if (edge === 'center-x') x = (left + right) / 2 - node.w / 2;
    else if (edge === 'top') y = top;
    else if (edge === 'bottom') y = bottom - node.h;
    else if (edge === 'center-y') y = (top + bottom) / 2 - node.h / 2;
    if (x !== node.x || y !== node.y) moves.set(node.id, { x, y });
  }
  return moves;
}

/** Even out the gaps between nodes along an axis, leaving the outermost fixed. */
export function distributeWorkspaceNodes(nodes: WorkspaceNode[], axis: 'x' | 'y'): Map<string, { x: number; y: number }> {
  const moves = new Map<string, { x: number; y: number }>();
  if (nodes.length < 3) return moves;

  const size = axis === 'x' ? (node: WorkspaceNode) => node.w : (node: WorkspaceNode) => node.h;
  const ordered = [...nodes].sort((a, b) => a[axis] - b[axis]);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const span = (last[axis] + size(last)) - first[axis];
  const occupied = ordered.reduce((total, node) => total + size(node), 0);
  const gap = (span - occupied) / (ordered.length - 1);

  let cursor = first[axis] + size(first) + gap;
  for (const node of ordered.slice(1, -1)) {
    const next = axis === 'x' ? { x: cursor, y: node.y } : { x: node.x, y: cursor };
    if (next.x !== node.x || next.y !== node.y) moves.set(node.id, next);
    cursor += size(node) + gap;
  }
  return moves;
}
