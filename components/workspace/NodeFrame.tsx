'use client';

import { useRef } from 'react';
import type { WorkspaceNode } from '@/lib/workspace/types';

type NodeFrameProps = {
  node: WorkspaceNode;
  selected: boolean;
  title: string;
  getZoom: () => number;
  onSelect: () => void;
  onOpenConversation: () => void;
  onCommit: (patch: Partial<WorkspaceNode>) => void;
  onWindowAction?: (action: 'minimize' | 'maximize' | 'restore') => void;
  onErase?: () => void;
  chromeless?: boolean;
  children: React.ReactNode;
};

const INTERACTIVE = 'button,input,textarea,select,iframe,video,audio,embed,a,[contenteditable]';

export function NodeFrame({ node, selected, title, getZoom, onSelect, onOpenConversation, onCommit, onWindowAction, chromeless, children }: NodeFrameProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const windowState = node.type === 'app' && typeof node.payload.windowState === 'string' ? node.payload.windowState : 'normal';

  const pointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    onSelect();
    if ((event.target as Element).closest(INTERACTIVE)) {
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: node.x, y: node.y, w: node.w, h: node.h };
    let next = { ...origin };
    const resize = event.altKey;
    const move = (current: PointerEvent) => {
      const zoom = getZoom();
      if (resize) {
        next.w = Math.max(80, origin.w + (current.clientX - startX) / zoom);
        next.h = Math.max(40, origin.h + (current.clientY - startY) / zoom);
        if (frame.current) {
          frame.current.style.width = `${next.w}px`;
          frame.current.style.height = `${next.h}px`;
        }
      } else {
        next.x = origin.x + (current.clientX - startX) / zoom;
        next.y = origin.y + (current.clientY - startY) / zoom;
        if (frame.current) frame.current.style.transform = `translate(${next.x}px, ${next.y}px)`;
      }
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      onCommit(resize ? { w: next.w, h: next.h } : { x: next.x, y: next.y });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  return (
    <section
      ref={frame}
      className="hii-node"
      data-node-id={node.id}
      data-selected={selected}
      data-chromeless={chromeless || undefined}
      data-window-state={node.type === 'app' ? windowState : undefined}
      onPointerDown={pointerDown}
      onDoubleClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onOpenConversation();
      }}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.w, height: node.h, zIndex: Math.round(node.z) }}
    >
      <span className="hii-node-caption">{title}</span>
      {node.type === 'app' && <div className="hii-app-window-controls" aria-label={`${title} window controls`}>
        <button aria-label={`Minimize ${title}`} title="Minimize" onClick={() => onWindowAction?.('minimize')}>−</button>
        <button aria-label={windowState === 'maximized' ? `Restore ${title}` : `Maximize ${title}`} title={windowState === 'maximized' ? 'Restore' : 'Maximize'} onClick={() => onWindowAction?.(windowState === 'maximized' ? 'restore' : 'maximize')}>{windowState === 'maximized' ? '↙' : '↗'}</button>
      </div>}
      <div className="hii-node-body">{children}</div>
    </section>
  );
}
