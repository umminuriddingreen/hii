import { describe, expect, it } from 'vitest';
import {
  INK_DEFAULT_COLOR,
  INK_DEFAULT_WIDTH,
  decimateStroke,
  readStrokes,
  simplifyStroke,
  strokeBounds,
  translateStrokes
} from '../../lib/workspace/ink';

describe('stroke simplification', () => {
  it('collapses a densely sampled straight line to its endpoints', () => {
    // What a pointer actually emits: many samples along one line.
    const dense: number[] = [];
    for (let step = 0; step <= 200; step += 1) dense.push(step, 0);

    expect(simplifyStroke(dense)).toEqual([0, 0, 200, 0]);
  });

  it('keeps the corners of a shape that actually has them', () => {
    const corner = [0, 0, 25, 0, 50, 0, 50, 25, 50, 50];
    expect(simplifyStroke(corner)).toEqual([0, 0, 50, 0, 50, 50]);
  });

  it('preserves the first and last point exactly, so a stroke does not shrink', () => {
    const wobbly = [3, 7, 20, 9, 40, 6, 60, 11, 91, 4];
    const simplified = simplifyStroke(wobbly);
    expect(simplified.slice(0, 2)).toEqual([3, 7]);
    expect(simplified.slice(-2)).toEqual([91, 4]);
  });

  it('substantially shrinks a hand-drawn stroke', () => {
    // A jittery arc, of the kind a real pen produces.
    const drawn: number[] = [];
    for (let step = 0; step < 400; step += 1) {
      drawn.push(step, Math.sin(step / 40) * 50 + Math.sin(step) * 0.2);
    }
    const simplified = simplifyStroke(drawn);
    expect(simplified.length).toBeLessThan(drawn.length / 5);
  });

  it('leaves a stroke too short to simplify alone', () => {
    expect(simplifyStroke([0, 0, 10, 10])).toEqual([0, 0, 10, 10]);
  });

  it('stays fast on a pathological stroke where nothing can be pruned', () => {
    // A pure zigzag is the worst case for Douglas-Peucker: every point is a real
    // corner, so no subrange is ever discarded. Without a cap this runs for
    // minutes on the pointerup handler.
    const zigzag: number[] = [];
    for (let step = 0; step < 100_000; step += 1) zigzag.push(step, step % 2);

    const started = Date.now();
    const simplified = simplifyStroke(zigzag);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(simplified.length).toBeGreaterThan(0);
  });

  it('keeps the pen-up position when a stroke has to be thinned', () => {
    const long: number[] = [];
    for (let step = 0; step < 20_000; step += 1) long.push(step, step % 2);
    expect(decimateStroke(long).slice(-2)).toEqual([19_999, 1]);
  });

  it('leaves an ordinary stroke untouched by the cap', () => {
    const ordinary = [0, 0, 1, 1, 2, 2];
    expect(decimateStroke(ordinary)).toBe(ordinary);
  });
});

describe('stroke bounds', () => {
  const stroke = (points: number[]) => ({ points, color: INK_DEFAULT_COLOR, width: INK_DEFAULT_WIDTH });

  it('pads the bounds so a thick stroke is not clipped at the node edge', () => {
    expect(strokeBounds([stroke([0, 0, 100, 50])], 10)).toEqual({ x: -10, y: -10, w: 120, h: 70 });
  });

  it('covers every stroke in the drawing', () => {
    const bounds = strokeBounds([stroke([0, 0, 10, 10]), stroke([-50, 200, -40, 210])], 0)!;
    expect(bounds).toEqual({ x: -50, y: 0, w: 60, h: 210 });
  });

  it('reports nothing for an empty drawing', () => {
    expect(strokeBounds([])).toBeNull();
  });

  it('re-bases points so they stay relative after the node origin moves', () => {
    const moved = translateStrokes([stroke([10, 20, 30, 40])], -10, -20);
    expect(moved[0].points).toEqual([0, 0, 20, 20]);
  });
});

describe('reading strokes off a saved node', () => {
  it('round-trips a well-formed stroke', () => {
    const parsed = readStrokes([{ points: [0, 0, 5, 5], color: '#ff0000', width: 8 }]);
    expect(parsed).toEqual([{ points: [0, 0, 5, 5], color: '#ff0000', width: 8 }]);
  });

  it('drops an orphaned coordinate rather than reading it as a pair', () => {
    // A truncated write would otherwise shift every following y into an x.
    expect(readStrokes([{ points: [0, 0, 5, 5, 9] }])[0].points).toEqual([0, 0, 5, 5]);
  });

  it('discards strokes too short to draw, and non-numeric junk', () => {
    expect(readStrokes([{ points: [1, 2] }, { points: 'nope' }, null, 7])).toEqual([]);
  });

  it('falls back to defaults for a missing colour or width', () => {
    const [parsed] = readStrokes([{ points: [0, 0, 1, 1] }]);
    expect(parsed.color).toBe(INK_DEFAULT_COLOR);
    expect(parsed.width).toBe(INK_DEFAULT_WIDTH);
  });

  it('clamps an absurd stroke width from a hand-edited file', () => {
    expect(readStrokes([{ points: [0, 0, 1, 1], width: 99_999 }])[0].width).toBe(64);
  });
});
