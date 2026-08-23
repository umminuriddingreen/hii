import { describe, expect, it } from 'vitest';
import { cameraForPinch } from '@/components/workspace/useCamera';

describe('Space camera pinch', () => {
  it('keeps the world point under the gesture midpoint while zooming and translating', () => {
    const origin = { x: 20, y: -10, z: 1 };
    const next = cameraForPinch(origin, { x: 120, y: 90 }, { x: 170, y: 130 }, 100, 200);
    expect(next).toEqual({ x: -30, y: -70, z: 2 });
    expect((170 - next.x) / next.z).toBe((120 - origin.x) / origin.z);
    expect((130 - next.y) / next.z).toBe((90 - origin.y) / origin.z);
  });

  it('clamps zoom to the shared camera limits', () => {
    expect(cameraForPinch({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 100).z).toBe(8);
  });
});
