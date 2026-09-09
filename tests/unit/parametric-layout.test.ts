import { describe, expect, it } from 'vitest';
import { parametricImageLayout } from '@/lib/workspace/parametric-layout';
import type { WorkspaceNode } from '@/lib/workspace/types';

const image = (id: string, year: string): WorkspaceNode => ({ id, type: 'image', x: 0, y: 0, w: 1, h: 1, z: 1, createdAt: year, updatedAt: year, payload: { year } });

describe('parametricImageLayout', () => {
  it('lays out only images with deterministic scaled dimensions', () => {
    const nodes = [image('b', '2025'), { ...image('note', '2024'), type: 'note' as const }, image('a', '2024')];
    const result = parametricImageLayout(nodes, { layout: 'chronology', scale: .5, spacing: 20, origin: { x: 0, y: 0 } });
    expect(result.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.every((item) => item.w === 130 && item.h === 98)).toBe(true);
    expect(result[0].x).toBeLessThan(result[1].x);
  });
});
