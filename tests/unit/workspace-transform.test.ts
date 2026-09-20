// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { describe, expect, it } from 'vitest';
import {
  normalizeNode,
  quaternionFromZDegrees,
  workspaceNodeTransform3D,
  type WorkspaceNode
} from '@/lib/workspace/types';

/**
 * The 2D plane and the 3D transform describe the same object, and this pins
 * which one wins when they disagree.
 *
 * The answer is the plane, for a reason that already caused a regression:
 * every writer in the product — the canvas drag, the realtime move event, the
 * replication merge — patches `x/y/w/h/rotation` and knows nothing about
 * `transform`. When a stored transform could override them, an ordinary 2D
 * move silently snapped back to the object's last 3D position and four test
 * files went red at once. The transform's job is only to carry what the plane
 * cannot say: depth, scale, and off-axis rotation.
 */

const base = {
  id: 'node-1',
  type: 'note' as const,
  x: 10,
  y: 20,
  w: 320,
  h: 240,
  z: 1,
  rotation: 0,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  payload: {}
};

describe('workspace transform', () => {
  it('lets a 2D move win over a stale stored transform', () => {
    const moved = normalizeNode({
      ...base,
      x: 900,
      y: 400,
      transform: {
        position: { x: 10, y: 20, z: 0 },
        rotation: quaternionFromZDegrees(0),
        scale: { x: 1, y: 1, z: 1 },
        size: { x: 320, y: 240, z: 0 }
      }
    }) as WorkspaceNode;

    expect(moved.x).toBe(900);
    expect(moved.y).toBe(400);
    expect(workspaceNodeTransform3D(moved).position).toMatchObject({ x: 900, y: 400 });
  });

  it('keeps depth, scale, and tilt that the plane cannot express', () => {
    const dimensional = normalizeNode({
      ...base,
      x: 900,
      transform: {
        position: { x: 10, y: 20, z: -140 },
        rotation: { x: 0.2588, y: 0, z: 0, w: 0.9659 },
        scale: { x: 2, y: 2, z: 2 },
        size: { x: 320, y: 240, z: 60 }
      }
    }) as WorkspaceNode;

    const transform = workspaceNodeTransform3D(dimensional);
    expect(transform.position.x).toBe(900);
    expect(transform.position.z).toBe(-140);
    expect(transform.scale).toMatchObject({ x: 2, y: 2, z: 2 });
    expect(transform.size.z).toBe(60);
    expect(transform.rotation.x).toBeCloseTo(0.2588, 3);
  });

  it('does not store a transform that only restates the plane', () => {
    const flat = normalizeNode(base) as WorkspaceNode;

    // Persisting a fully derived copy doubles every document and gives a stale
    // plane somewhere to hide; the 3D view derives it on demand instead.
    expect(flat.transform).toBeUndefined();
    expect(workspaceNodeTransform3D(flat)).toMatchObject({
      position: { x: 10, y: 20, z: 0 },
      size: { x: 320, y: 240, z: 0 }
    });
  });

  it('re-derives rotation once the plane and the quaternion disagree', () => {
    const rotated = normalizeNode({
      ...base,
      rotation: 90,
      transform: {
        position: { x: 10, y: 20, z: 0 },
        rotation: quaternionFromZDegrees(0),
        scale: { x: 1, y: 1, z: 1 },
        size: { x: 320, y: 240, z: 0 }
      }
    }) as WorkspaceNode;

    expect(rotated.rotation).toBe(90);
    expect(workspaceNodeTransform3D(rotated).rotation.z).toBeCloseTo(Math.sin(Math.PI / 4), 4);
  });
});
