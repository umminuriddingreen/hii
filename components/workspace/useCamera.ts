'use client';

import { useCallback, useEffect, useRef } from 'react';
import { trackPointerGesture } from '../../lib/workspace/gestures';
import type { WorkspaceViewport } from '../../lib/workspace/types';

export type Camera = { x: number; y: number; z: number };
export type ScreenPoint = { x: number; y: number };

const GRID = 32;

/** Shared zoom limits. Every path that changes `z` clamps through `clampZoom`. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

/** Keyboard pan distance in screen pixels, and its coarse (shift) multiplier. */
export const KEY_PAN_STEP = 64;
export const KEY_PAN_COARSE = 4;
/** Keyboard zoom ratio per press. */
export const KEY_ZOOM_STEP = 1.2;

export type SemanticZoomLevel = 'territory' | 'space' | 'objects' | 'detail';

export function semanticZoomLevel(zoom: number): SemanticZoomLevel {
  if (zoom < 0.18) return 'territory';
  if (zoom < 0.45) return 'space';
  if (zoom < 0.9) return 'objects';
  return 'detail';
}

export function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * Wheel deltas are only pixels when `deltaMode` says so. Firefox reports lines
 * for many mice and pages for some trackpads, so an un-normalized handler pans
 * and zooms roughly two orders of magnitude too slowly there. The remote desktop
 * surface already normalizes this; the canvas is the surface that matters most.
 */
export function normalizeWheelDelta(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): {
  dx: number;
  dy: number;
} {
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  return { dx: event.deltaX * factor, dy: event.deltaY * factor };
}

/**
 * Scale about a fixed screen point, keeping the world coordinate under `focus`
 * exactly where it is. Shared by wheel zoom, pinch, and keyboard zoom so all
 * three agree on the anchor and the limits.
 */
export function cameraForZoom(origin: Camera, focus: ScreenPoint, factor: number): Camera {
  const z = clampZoom(origin.z * factor);
  const k = z / origin.z;
  return { x: focus.x - (focus.x - origin.x) * k, y: focus.y - (focus.y - origin.y) * k, z };
}

/**
 * Keyboard intent for the camera.
 *
 * A spatial canvas whose viewport only moves under a pointer is unreachable for
 * anyone driving it from the keyboard: content parked off-screen cannot be
 * brought into view at all. Arrows pan only when nothing is selected, so they
 * still nudge a selected object first; zoom uses the platform-standard
 * modifier pair, which also keeps it clear of direct canvas typing.
 */
export type CameraKeyIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number }
  | null;

export function cameraKeyIntent(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  hasSelection: boolean
): CameraKeyIntent {
  if (event.altKey) return null;
  const accel = event.metaKey || event.ctrlKey;
  if (accel) {
    if (event.key === '=' || event.key === '+') return { kind: 'zoom', factor: KEY_ZOOM_STEP };
    if (event.key === '-' || event.key === '_') return { kind: 'zoom', factor: 1 / KEY_ZOOM_STEP };
    return null;
  }
  if (hasSelection) return null;
  const step = KEY_PAN_STEP * (event.shiftKey ? KEY_PAN_COARSE : 1);
  switch (event.key) {
    // The camera translates the world, so panning the view right moves it left.
    case 'ArrowRight': return { kind: 'pan', dx: -step, dy: 0 };
    case 'ArrowLeft': return { kind: 'pan', dx: step, dy: 0 };
    case 'ArrowDown': return { kind: 'pan', dx: 0, dy: -step };
    case 'ArrowUp': return { kind: 'pan', dx: 0, dy: step };
    default: return null;
  }
}

export function cameraForPinch(origin: Camera, startMidpoint: ScreenPoint, currentMidpoint: ScreenPoint, startDistance: number, currentDistance: number): Camera {
  const z = clampZoom(origin.z * currentDistance / Math.max(1, startDistance));
  const worldX = (startMidpoint.x - origin.x) / origin.z;
  const worldY = (startMidpoint.y - origin.y) / origin.z;
  return { x: currentMidpoint.x - worldX * z, y: currentMidpoint.y - worldY * z, z };
}

function midpoint(a: ScreenPoint, b: ScreenPoint): ScreenPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: ScreenPoint, b: ScreenPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function useCamera(onSettle?: () => void) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, z: 1 });
  const raf = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touches = useRef(new Map<number, ScreenPoint>());
  const touchListening = useRef(false);
  const touchPanLast = useRef<ScreenPoint | null>(null);
  const pinch = useRef<{ camera: Camera; midpoint: ScreenPoint; distance: number } | null>(null);

  const apply = useCallback(() => {
    raf.current = 0;
    const { x, y, z } = cam.current;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    }
    if (viewportRef.current) {
      viewportRef.current.style.backgroundPosition = `${x}px ${y}px`;
      viewportRef.current.style.backgroundSize = `${GRID * z}px ${GRID * z}px`;
      viewportRef.current.style.setProperty('--hii-camera-zoom', String(z));
      viewportRef.current.dataset.zoomLevel = semanticZoomLevel(z);
    }
  }, []);

  const commit = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(apply);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => onSettle?.(), 400);
  }, [apply, onSettle]);

  const toWorld = useCallback((cx: number, cy: number) => {
    const { x, y, z } = cam.current;
    return { x: (cx - x) / z, y: (cy - y) / z };
  }, []);

  const centerWorld = useCallback(
    () => toWorld(window.innerWidth / 2, window.innerHeight / 2),
    [toWorld]
  );

  const reset = useCallback(() => {
    cam.current = { x: 0, y: 0, z: 1 };
    commit();
  }, [commit]);

  const setViewport = useCallback(
    (viewport: WorkspaceViewport) => {
      cam.current = { x: viewport.x, y: viewport.y, z: viewport.zoom };
      commit();
    },
    [commit]
  );

  const getViewport = useCallback(
    (): WorkspaceViewport => ({ x: cam.current.x, y: cam.current.y, zoom: cam.current.z }),
    []
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('[data-workspace-ui]')) return;
      if (!e.ctrlKey && !e.metaKey && (e.target as Element).closest('.scroll, .xterm, iframe')) return;
      e.preventDefault();
      const c = cam.current;
      const { dx, dy } = normalizeWheelDelta(e);
      if (e.ctrlKey || e.metaKey) {
        cam.current = cameraForZoom(c, { x: e.clientX, y: e.clientY }, Math.exp(-dy * 0.01));
      } else {
        c.x -= dx;
        c.y -= dy;
      }
      commit();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit]);

  const panStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const origin = { x: cam.current.x, y: cam.current.y };
      document.documentElement.setAttribute('data-workspace-dragging', '1');
      const release = () => document.documentElement.removeAttribute('data-workspace-dragging');
      // Shared gesture core: batches to a frame, ignores other pointers, and —
      // unlike the hand-rolled listeners this replaces — always tears down, so an
      // interrupted pan (system gesture, window blur) cannot leave a live
      // `pointermove` listener dragging the camera forever.
      trackPointerGesture(e.nativeEvent, {
        onMove: ({ dx, dy }) => {
          cam.current.x = origin.x + dx;
          cam.current.y = origin.y + dy;
          commit();
        },
        onEnd: release,
        // An interrupted pan keeps the view where the person already moved it.
        // Reverting to the origin would be correct for dragging an object and
        // wrong for a viewport: the movement so far was deliberate and seen.
        onCancel: release
      });
    },
    [commit]
  );

  /** Pan by a screen-space offset. The keyboard path into the camera. */
  const panBy = useCallback(
    (dx: number, dy: number) => {
      cam.current.x += dx;
      cam.current.y += dy;
      commit();
    },
    [commit]
  );

  /**
   * Zoom about a screen point, defaulting to the centre of the viewport — the
   * only anchor a keyboard user can be said to be pointing at.
   */
  const zoomBy = useCallback(
    (factor: number, focus?: ScreenPoint) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const anchor = focus ?? {
        x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
        y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2
      };
      cam.current = cameraForZoom(cam.current, anchor, factor);
      commit();
    },
    [commit]
  );

  const touchStart = useCallback((event: React.PointerEvent) => {
    if (event.pointerType !== 'touch') return false;
    event.preventDefault();
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...touches.current.values()];
    if (points.length >= 2) {
      pinch.current = { camera: { ...cam.current }, midpoint: midpoint(points[0], points[1]), distance: distance(points[0], points[1]) };
      touchPanLast.current = null;
    } else {
      touchPanLast.current = points[0];
    }
    if (touchListening.current) return true;
    touchListening.current = true;
    const move = (current: PointerEvent) => {
      if (!touches.current.has(current.pointerId)) return;
      current.preventDefault();
      touches.current.set(current.pointerId, { x: current.clientX, y: current.clientY });
      const active = [...touches.current.values()];
      if (active.length >= 2 && pinch.current) {
        cam.current = cameraForPinch(pinch.current.camera, pinch.current.midpoint, midpoint(active[0], active[1]), pinch.current.distance, distance(active[0], active[1]));
      } else if (active.length === 1 && touchPanLast.current) {
        cam.current.x += active[0].x - touchPanLast.current.x;
        cam.current.y += active[0].y - touchPanLast.current.y;
        touchPanLast.current = active[0];
      }
      commit();
    };
    const end = (current: PointerEvent) => {
      if (!touches.current.has(current.pointerId)) return;
      touches.current.delete(current.pointerId);
      const active = [...touches.current.values()];
      pinch.current = null;
      touchPanLast.current = active[0] ?? null;
      if (active.length) return;
      touchListening.current = false;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    return true;
  }, [commit]);

  return { viewportRef, worldRef, cam, toWorld, centerWorld, reset, setViewport, getViewport, panStart, panBy, zoomBy, touchStart };
}
