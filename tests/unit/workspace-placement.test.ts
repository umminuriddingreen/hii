import { describe, expect, it } from 'vitest';
import { flowSeedPlacements } from '../../lib/workspace/placement';
import type { NodeSeed } from '../../lib/workspace/ingest';

const pdf = (w = 620, h = 720): NodeSeed => ({ type: 'document', w, h, payload: { kind: 'pdf' } });

describe('workspace file placement', () => {
  it('centers a multi-PDF import in non-overlapping rows', () => {
    const seeds = Array.from({ length: 5 }, () => pdf());
    const points = flowSeedPlacements(seeds, { x: 1_000, y: 1_000 }, 2_000, 40);

    expect(points).toEqual([
      { x: 30, y: 260 },
      { x: 690, y: 260 },
      { x: 1_350, y: 260 },
      { x: 360, y: 1_020 },
      { x: 1_020, y: 1_020 }
    ]);
  });

  it('uses the tallest object to clear the next row', () => {
    const points = flowSeedPlacements([pdf(500, 300), pdf(500, 700), pdf(500, 200)], { x: 0, y: 0 }, 1_040, 40);
    expect(points[2].y - points[0].y).toBe(740);
  });
});
