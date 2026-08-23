'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { WorkspaceViewport } from '../../lib/workspace/types';

export type Camera = { x: number; y: number; z: number };
export type ScreenPoint = { x: number; y: number };

const GRID = 32;

export function cameraForPinch(origin: Camera, startMidpoint: ScreenPoint, currentMidpoint: ScreenPoint, startDistance: number, currentDistance: number): Camera {
  const z = Math.min(8, Math.max(0.05, origin.z * currentDistance / Math.max(1, startDistance)));
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
      if (e.ctrlKey || e.metaKey) {
        const z = Math.min(8, Math.max(0.05, c.z * Math.exp(-e.deltaY * 0.01)));
        const k = z / c.z;
        c.x = e.clientX - (e.clientX - c.x) * k;
        c.y = e.clientY - (e.clientY - c.y) * k;
        c.z = z;
      } else {
        c.x -= e.deltaX;
        c.y -= e.deltaY;
      }
      commit();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit]);

  const panStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = cam.current.x;
      const oy = cam.current.y;
      document.documentElement.setAttribute('data-workspace-dragging', '1');
      const move = (ev: PointerEvent) => {
        cam.current.x = ox + ev.clientX - sx;
        cam.current.y = oy + ev.clientY - sy;
        commit();
      };
      const up = () => {
        document.documentElement.removeAttribute('data-workspace-dragging');
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
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

  return { viewportRef, worldRef, cam, toWorld, centerWorld, reset, setViewport, getViewport, panStart, touchStart };
}
