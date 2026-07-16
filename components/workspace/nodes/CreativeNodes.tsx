'use client';

import { useEffect, useRef } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type NodeBodyProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

type InkPoint = { x: number; y: number };

function inkPoints(value: unknown): InkPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => {
      if (!point || typeof point !== 'object') return null;
      const x = Number((point as InkPoint).x);
      const y = Number((point as InkPoint).y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    })
    .filter((point): point is InkPoint => point !== null)
    .slice(0, 10_000);
}

export function CanvasTextNode({ node, onPayload }: NodeBodyProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (node.payload.autofocus === true) {
      ref.current?.focus();
      ref.current?.select();
      onPayload({ autofocus: false });
    }
  }, [node.payload.autofocus, onPayload]);

  return (
    <textarea
      ref={ref}
      value={String(node.payload.text ?? '')}
      onChange={(event) => onPayload({ text: event.target.value })}
      placeholder="Type on the canvas…"
      className="h-full w-full resize-none bg-transparent px-5 py-4 text-[26px] font-medium leading-[1.12] tracking-[-0.025em] text-[var(--hii-graphite)] outline-none placeholder:text-neutral-300"
      style={{ color: String(node.payload.color || 'var(--hii-graphite)') }}
    />
  );
}

export function InkNode({ node }: NodeBodyProps) {
  const points = inkPoints(node.payload.points);
  if (points.length < 2) return null;
  const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  return (
    <svg viewBox={`0 0 ${node.w} ${node.h}`} className="pointer-events-none h-full w-full overflow-visible" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={String(node.payload.color || '#171717')}
        strokeWidth={Number(node.payload.width || 4)}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={Number(node.payload.opacity ?? 1)}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
