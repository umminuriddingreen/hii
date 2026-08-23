'use client';

import { useEffect, useMemo, useRef } from 'react';
import { paintStrokes, readLegacyStroke, readStrokes } from '@/lib/workspace/ink';
import type { WorkspaceNode } from '@/lib/workspace/types';

export function InkBody({ node }: { node: WorkspaceNode }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const strokes = useMemo(() => {
    const current = readStrokes(node.payload.strokes);
    const legacy = readLegacyStroke(node.payload);
    return legacy && !current.length ? [legacy] : current;
  }, [node.payload]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    element.width = Math.max(1, Math.round(node.w * ratio));
    element.height = Math.max(1, Math.round(node.h * ratio));
    const context = element.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, node.w, node.h);
    paintStrokes(context, strokes);
  }, [node.h, node.w, strokes]);

  return <canvas ref={canvas} className="hii-ink-canvas" aria-label="Drawing" />;
}
