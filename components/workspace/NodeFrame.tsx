'use client';

import { useRef } from 'react';
import { workspaceNodeTransform, type WorkspaceNode } from '@/lib/workspace/types';
import {
  isNodeLocked,
  resizeNodeRect,
  rotationFromPointer,
  type NodeResizeHandle,
  type NodeTransformDetail,
  type NodeTransformKind,
  type NodeTransformRect
} from './nodeTransform';
import styles from './NodeFrame.module.css';

type NodeFrameProps = {
  node: WorkspaceNode;
  selected: boolean;
  title: string;
  getZoom: () => number;
  onSelect: (event: React.PointerEvent) => void;
  onOpenConversation: () => void;
  onCommit: (patch: Partial<WorkspaceNode>) => void;
  onTransformStart?: (detail: NodeTransformDetail) => void;
  onTransformPreview?: (detail: NodeTransformDetail) => Partial<NodeTransformRect> | void;
  onTransformCommit?: (detail: NodeTransformDetail) => void;
  onWindowAction?: (action: 'minimize' | 'maximize' | 'restore') => void;
  onErase?: () => void;
  onShare?: () => void;
  touchControls?: boolean;
  chromeless?: boolean;
  contentActive?: boolean;
  onActivateContent?: () => void;
  children: React.ReactNode;
};

const INTERACTIVE = 'button,input,textarea,select,iframe,video,audio,embed,a,[contenteditable],.xterm';

export function NodeFrame({ node, selected, title, getZoom, onSelect, onOpenConversation, onCommit, onTransformStart, onTransformPreview, onTransformCommit, onWindowAction, onErase, onShare, touchControls, chromeless, contentActive, onActivateContent, children }: NodeFrameProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const windowed = node.type === 'app' || node.type === 'terminal';
  const locked = isNodeLocked(node);
  const windowState = windowed && typeof node.payload.windowState === 'string' ? node.payload.windowState : 'normal';

  const beginGesture = (event: React.PointerEvent, kind: NodeTransformKind = 'move', handle?: NodeResizeHandle) => {
    if (event.button !== 0) return;
    onSelect(event);
    if ((event.target as Element).closest(INTERACTIVE)) {
      event.stopPropagation();
      return;
    }
    if (locked) {
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin: NodeTransformRect = { x: node.x, y: node.y, w: node.w, h: node.h, rotation: node.rotation };
    let next = { ...origin };
    const transformKind: NodeTransformKind = kind === 'move' && event.altKey ? 'resize' : kind;
    const resizeHandle = handle || 'se';
    const detail = (current: PointerEvent | React.PointerEvent): NodeTransformDetail => ({
      nodeId: node.id,
      kind: transformKind,
      handle: transformKind === 'resize' ? resizeHandle : undefined,
      origin,
      next,
      delta: { x: next.x - origin.x, y: next.y - origin.y },
      modifiers: {
        altKey: current.altKey,
        shiftKey: current.shiftKey,
        metaKey: current.metaKey,
        ctrlKey: current.ctrlKey
      }
    });
    onTransformStart?.(detail(event));
    const move = (current: PointerEvent) => {
      const zoom = getZoom();
      const deltaX = (current.clientX - startX) / zoom;
      const deltaY = (current.clientY - startY) / zoom;
      if (transformKind === 'resize') {
        next = resizeNodeRect(origin, resizeHandle, deltaX, deltaY);
      } else if (transformKind === 'rotate') {
        next = { ...origin, rotation: rotationFromPointer(origin, {
          x: origin.x + origin.w / 2 + (current.clientX - startX) / zoom,
          y: origin.y - 28 + (current.clientY - startY) / zoom
        }, current.shiftKey) };
      } else {
        next.x = origin.x + (current.clientX - startX) / zoom;
        next.y = origin.y + (current.clientY - startY) / zoom;
      }
      const override = onTransformPreview?.(detail(current));
      if (override) next = { ...next, ...override };
      if (frame.current) {
        frame.current.style.transform = workspaceNodeTransform(next);
        frame.current.style.width = `${next.w}px`;
        frame.current.style.height = `${next.h}px`;
      }
    };
    const up = (current: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      const finalDetail = detail(current);
      if (onTransformCommit) onTransformCommit(finalDetail);
      else if (transformKind === 'resize') onCommit({ x: next.x, y: next.y, w: next.w, h: next.h });
      else if (transformKind === 'rotate') onCommit({ rotation: next.rotation });
      else onCommit({ x: next.x, y: next.y });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };

  const pointerDown = (event: React.PointerEvent) => beginGesture(event);

  return (
    <section
      ref={frame}
      className="hii-node"
      data-node-id={node.id}
      data-node-type={node.type}
      data-selected={selected}
      data-chromeless={chromeless || undefined}
      data-content-active={contentActive || undefined}
      data-locked={locked || undefined}
      data-window-state={windowed ? windowState : undefined}
      onPointerDown={pointerDown}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if ((event.target as Element).closest(INTERACTIVE)) return;
        event.preventDefault();
        if (node.type === 'terminal' && (event.target as Element).closest('.hii-job-terminal header')) {
          onWindowAction?.(windowState === 'maximized' ? 'restore' : 'maximize');
          return;
        }
        if (node.type === 'document') {
          onActivateContent?.();
          return;
        }
        onOpenConversation();
      }}
      style={{
        transform: workspaceNodeTransform(node),
        width: node.w,
        height: node.h,
        zIndex: Math.round(node.z),
        outline: node.type === 'image' ? 'none' : undefined
      }}
    >
      {node.type !== 'image' && <span className="hii-node-caption">{title}</span>}
      {node.type === 'terminal' && <>
        <div className="hii-terminal-window-controls" role="group" aria-label={`${title} window controls`}>
          <button
            type="button"
            className="hii-terminal-close"
            aria-label={`Close ${title}`}
            title="Close terminal"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onErase}
          />
          <button
            type="button"
            className="hii-terminal-minimize"
            aria-label={windowState === 'minimized' ? `Restore ${title}` : `Minimize ${title}`}
            title={windowState === 'minimized' ? 'Restore terminal' : 'Minimize terminal'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onWindowAction?.(windowState === 'minimized' ? 'restore' : 'minimize')}
          />
          <button
            type="button"
            className="hii-terminal-maximize"
            aria-label={windowState === 'maximized' ? `Restore ${title}` : `Maximize ${title}`}
            title={windowState === 'maximized' ? 'Restore terminal' : 'Maximize terminal'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onWindowAction?.(windowState === 'maximized' ? 'restore' : 'maximize')}
          />
        </div>
        <button
          type="button"
          className="hii-terminal-resize"
          aria-label={`Resize ${title}`}
          title="Drag to resize terminal"
          onPointerDown={(event) => beginGesture(event, 'resize', 'se')}
        />
      </>}
      {touchControls && selected && <div className="hii-node-touch-controls" data-workspace-ui>
        {onShare && <button type="button" className="hii-node-share" aria-label={`Share ${title}`} onPointerDown={(event) => event.stopPropagation()} onClick={onShare}>Share</button>}
        <button type="button" className="hii-node-delete" aria-label={`Delete ${title}`} onPointerDown={(event) => event.stopPropagation()} onClick={onErase}>Delete</button>
        {!locked && <button type="button" className="hii-node-resize" aria-label={`Resize ${title}`} onPointerDown={(event) => beginGesture(event, 'resize', 'se')}>Resize</button>}
      </div>}
      {node.type === 'app' && <div className="hii-app-window-controls" aria-label={`${title} window controls`}>
        <button aria-label={`Minimize ${title}`} title="Minimize" onClick={() => onWindowAction?.('minimize')}>−</button>
        <button aria-label={windowState === 'maximized' ? `Restore ${title}` : `Maximize ${title}`} title={windowState === 'maximized' ? 'Restore' : 'Maximize'} onClick={() => onWindowAction?.(windowState === 'maximized' ? 'restore' : 'maximize')}>{windowState === 'maximized' ? '↙' : '↗'}</button>
      </div>}
      <div className="hii-node-body">{children}</div>
      {selected && !windowed && !locked && <div className={`hii-node-transform-handles ${styles.handles}`} data-workspace-ui aria-label={`${title} transform handles`}>
        {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((handle) => (
          <button
            key={handle}
            type="button"
            className={`hii-node-transform-handle ${styles.handle}`}
            data-handle={handle}
            aria-label={`Resize ${title} ${handle}`}
            onPointerDown={(event) => beginGesture(event, 'resize', handle)}
          />
        ))}
        <button
          type="button"
          className={`hii-node-rotation-handle ${styles.rotationHandle}`}
          aria-label={`Rotate ${title}`}
          title="Drag to rotate · hold Shift to snap"
          onPointerDown={(event) => beginGesture(event, 'rotate')}
        />
      </div>}
      {selected && locked && <span className={`hii-node-lock-indicator ${styles.lockIndicator}`} data-workspace-ui role="status" aria-label={`${title} is locked`}>Locked</span>}
    </section>
  );
}
