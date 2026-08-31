import { describe, expect, it } from 'vitest';
import {
  KEY_PAN_COARSE,
  KEY_PAN_STEP,
  KEY_ZOOM_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
  cameraForZoom,
  cameraKeyIntent,
  clampZoom,
  normalizeWheelDelta
} from '@/components/workspace/useCamera';

const key = (over: Partial<KeyboardEvent> & { key: string }) => ({
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over
});

describe('wheel normalization', () => {
  it('passes pixel deltas through unchanged', () => {
    expect(normalizeWheelDelta({ deltaX: 10, deltaY: -20, deltaMode: 0 })).toEqual({ dx: 10, dy: -20 });
  });

  it('converts line and page deltas to pixels', () => {
    // Firefox reports lines for many mice; un-normalized this pans ~16x too slowly.
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: 48 });
    expect(normalizeWheelDelta({ deltaX: 1, deltaY: 0, deltaMode: 2 })).toEqual({ dx: 400, dy: 0 });
  });
});

describe('zoom about a point', () => {
  it('keeps the world coordinate under the focus point fixed', () => {
    const origin = { x: 40, y: -15, z: 1.5 };
    const focus = { x: 300, y: 200 };
    const next = cameraForZoom(origin, focus, 2);
    expect((focus.x - next.x) / next.z).toBeCloseTo((focus.x - origin.x) / origin.z, 10);
    expect((focus.y - next.y) / next.z).toBeCloseTo((focus.y - origin.y) / origin.z, 10);
  });

  it('clamps to the shared limits rather than each caller inventing its own', () => {
    expect(cameraForZoom({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, 1e6).z).toBe(ZOOM_MAX);
    expect(cameraForZoom({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, 1e-6).z).toBe(ZOOM_MIN);
    expect(clampZoom(ZOOM_MAX * 2)).toBe(ZOOM_MAX);
  });
});

describe('keyboard camera intent', () => {
  it('pans the viewport with the arrows when nothing is selected', () => {
    expect(cameraKeyIntent(key({ key: 'ArrowRight' }), false)).toEqual({ kind: 'pan', dx: -KEY_PAN_STEP, dy: 0 });
    expect(cameraKeyIntent(key({ key: 'ArrowLeft' }), false)).toEqual({ kind: 'pan', dx: KEY_PAN_STEP, dy: 0 });
    expect(cameraKeyIntent(key({ key: 'ArrowDown' }), false)).toEqual({ kind: 'pan', dx: 0, dy: -KEY_PAN_STEP });
    expect(cameraKeyIntent(key({ key: 'ArrowUp' }), false)).toEqual({ kind: 'pan', dx: 0, dy: KEY_PAN_STEP });
  });

  it('yields the arrows to a selection so objects still nudge first', () => {
    for (const arrow of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(cameraKeyIntent(key({ key: arrow }), true)).toBeNull();
    }
  });

  it('pans further with shift held', () => {
    expect(cameraKeyIntent(key({ key: 'ArrowRight', shiftKey: true }), false)).toEqual({
      kind: 'pan',
      dx: -KEY_PAN_STEP * KEY_PAN_COARSE,
      dy: 0
    });
  });

  it('zooms on the platform-standard modifier pair, with or without a selection', () => {
    for (const hasSelection of [false, true]) {
      expect(cameraKeyIntent(key({ key: '=', metaKey: true }), hasSelection)).toEqual({ kind: 'zoom', factor: KEY_ZOOM_STEP });
      expect(cameraKeyIntent(key({ key: '-', ctrlKey: true }), hasSelection)).toEqual({ kind: 'zoom', factor: 1 / KEY_ZOOM_STEP });
    }
    expect(cameraKeyIntent(key({ key: '+', metaKey: true }), false)).toEqual({ kind: 'zoom', factor: KEY_ZOOM_STEP });
  });

  it('leaves bare punctuation alone so direct canvas typing still works', () => {
    expect(cameraKeyIntent(key({ key: '-' }), false)).toBeNull();
    expect(cameraKeyIntent(key({ key: '=' }), false)).toBeNull();
  });

  it('ignores anything carrying alt, which belongs to the platform', () => {
    expect(cameraKeyIntent(key({ key: 'ArrowRight', altKey: true }), false)).toBeNull();
    expect(cameraKeyIntent(key({ key: '=', metaKey: true, altKey: true }), false)).toBeNull();
  });

  it('does not claim ordinary keys', () => {
    expect(cameraKeyIntent(key({ key: 'a' }), false)).toBeNull();
    expect(cameraKeyIntent(key({ key: 'Enter' }), false)).toBeNull();
  });
});
