'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { WorkspaceViewport } from '../../lib/workspace/types';

export type Camera = { x: number; y: number; z: number };

const GRID = 32;

export function useCamera(onSettle?: () => void) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, z: 1 });
  const raf = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return { viewportRef, worldRef, cam, toWorld, centerWorld, reset, setViewport, getViewport, panStart };
}
