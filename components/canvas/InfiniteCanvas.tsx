'use client';

import { PointerEvent, WheelEvent, useRef, useState } from 'react';

type View = { x: number; y: number; zoom: number };

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

export function InfiniteCanvas() {
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const zoom = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    setView((current) => {
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
      const ratio = nextZoom / current.zoom;
      return {
        zoom: nextZoom,
        x: event.clientX - (event.clientX - current.x) * ratio,
        y: event.clientY - (event.clientY - current.y) * ratio
      };
    });
  };

  return (
    <main
      className="hii-infinite-canvas"
      aria-label="Infinite 2D canvas"
      style={{
        '--canvas-x': `${view.x}px`,
        '--canvas-y': `${view.y}px`,
        '--canvas-grid': `${24 * view.zoom}px`
      } as React.CSSProperties}
      onWheel={zoom}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
    />
  );
}
