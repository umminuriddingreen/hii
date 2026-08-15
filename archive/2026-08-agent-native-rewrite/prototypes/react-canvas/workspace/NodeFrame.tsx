'use client';

import { useRef } from 'react';
import type { WorkspaceNode } from '../../lib/workspace/types';

type NodeFrameProps = {
  node: WorkspaceNode;
  selected: boolean;
  title: string;
  getZoom: () => number;
  onSelect: () => void;
  onCommit: (patch: Partial<WorkspaceNode>) => void;
  onClose: () => void;
  onErase?: () => void;
  chromeless?: boolean;
  children: React.ReactNode;
};

const INTERACTIVE = 'input,textarea,select,iframe,video,audio,embed,a,button,.scroll,.xterm,[contenteditable]';

export function NodeFrame({ node, selected, title, getZoom, onSelect, onCommit, onClose, onErase, chromeless, children }: NodeFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);

  const dragStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (onErase) {
      e.stopPropagation();
      e.preventDefault();
      onErase();
      return;
    }
    onSelect();
    if ((e.target as Element).closest(INTERACTIVE)) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = node.x;
    const oy = node.y;
    let nx = ox;
    let ny = oy;
    document.documentElement.setAttribute('data-workspace-dragging', '1');
    const move = (ev: PointerEvent) => {
      const z = getZoom();
      nx = ox + (ev.clientX - sx) / z;
      ny = oy + (ev.clientY - sy) / z;
      if (frameRef.current) frameRef.current.style.transform = `translate(${nx}px, ${ny}px)`;
    };
    const up = () => {
      document.documentElement.removeAttribute('data-workspace-dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (nx !== ox || ny !== oy) onCommit({ x: nx, y: ny });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const resizeStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const sx = e.clientX;
    const sy = e.clientY;
    const ow = node.w;
    const oh = node.h;
    let nw = ow;
    let nh = oh;
    document.documentElement.setAttribute('data-workspace-dragging', '1');
    const move = (ev: PointerEvent) => {
      const z = getZoom();
      nw = Math.max(140, ow + (ev.clientX - sx) / z);
      nh = Math.max(80, oh + (ev.clientY - sy) / z);
      if (frameRef.current) {
        frameRef.current.style.width = `${nw}px`;
        frameRef.current.style.height = `${nh}px`;
      }
    };
    const up = () => {
      document.documentElement.removeAttribute('data-workspace-dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (nw !== ow || nh !== oh) onCommit({ w: nw, h: nh });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  return (
    <div
      ref={frameRef}
      data-node-id={node.id}
      onPointerDown={dragStart}
      className={`group absolute left-0 top-0 flex cursor-grab flex-col rounded-lg active:cursor-grabbing ${chromeless ? 'overflow-visible bg-transparent' : 'overflow-hidden bg-white'} ${
        chromeless
          ? selected ? 'shadow-[0_0_0_1px_var(--hii-electric-blue)]' : ''
          : selected
            ? 'shadow-[0_0_0_1px_var(--hii-electric-blue),0_8px_24px_rgba(23,23,23,0.08)]'
            : 'shadow-[0_0_0_1px_rgba(23,23,23,0.12),0_4px_16px_rgba(23,23,23,0.05)]'
      }`}
      style={{
        transform: `translate(${node.x}px, ${node.y}px)`,
        width: node.w,
        height: node.h,
        zIndex: Math.round(node.z),
        contain: 'content'
      }}
    >
      {!chromeless && (
        <div className="flex h-7 shrink-0 items-center justify-between border-b border-neutral-900/10 px-2.5">
          <span className="select-none truncate font-mono text-[11px] lowercase tracking-wide text-neutral-500">{title}</span>
          <button
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-700 group-hover:opacity-100"
            aria-label="close node"
          >
            ×
          </button>
        </div>
      )}
      {chromeless && selected && (
        <div data-node-drag-handle className="absolute -left-2 -top-2 z-20 grid h-5 w-5 select-none place-items-center rounded-full bg-white font-mono text-[10px] text-neutral-500 shadow-[0_0_0_1px_rgba(23,23,23,0.16),0_3px_10px_rgba(23,23,23,0.12)]" title="Drag">
          ⠿
        </div>
      )}
      <div className="relative min-h-0 flex-1">{children}</div>
      <div
        onPointerDown={resizeStart}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          backgroundImage: 'linear-gradient(135deg, transparent 50%, rgba(23,23,23,0.25) 50%)',
          borderBottomRightRadius: 8
        }}
      />
    </div>
  );
}
