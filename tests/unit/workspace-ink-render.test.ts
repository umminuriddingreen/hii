import { describe, expect, it, vi } from 'vitest';
import { inkSeedFromPoints } from '@/components/spaces/ink-capture';
import { paintStrokes } from '@/lib/workspace/ink';

describe('Workspace ink renderer used by Spaces', () => {
  it('captures a world-space gesture as a bounded existing ink node', () => {
    const captured = inkSeedFromPoints([100, 200, 120, 220, 140, 210]);
    expect(captured?.seed.type).toBe('ink');
    expect(captured?.seed.payload.strokes).toHaveLength(1);
    expect(captured?.at.x).toBeLessThan(100);
  });

  it('paints stored strokes into the 2d canvas contract', () => {
    const context = {
      beginPath: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      lineCap: '', lineJoin: '', strokeStyle: '', lineWidth: 0
    } as unknown as CanvasRenderingContext2D;
    paintStrokes(context, [{ points: [0, 0, 10, 10, 20, 0], color: '#000', width: 3 }]);
    expect(context.moveTo).toHaveBeenCalledWith(0, 0);
    expect(context.stroke).toHaveBeenCalledOnce();
  });
});
