'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasNode, CanvasNodeType } from '../../lib/canvas/types';
import { makeNode, seedFor, seedsFromDataTransfer, seedFromFile, seedFromString, type NodeSeed } from '../../lib/canvas/ingest';
import { useCamera } from './useCamera';
import { useWorkspace } from './useWorkspace';
import { NodeFrame } from './NodeFrame';
import { CommandBar } from './CommandBar';
import { FileNode, FontNode, HtmlNode, ImageNode, LinkNode, MediaNode, NoteNode, TextNode } from './nodes/StaticNodes';
import { ptyKill } from './usePtySocket';

const TerminalNode = dynamic(() => import('./nodes/TerminalNode'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">starting terminal…</div>
});
const BrowserNode = dynamic(() => import('./nodes/BrowserNode'), { ssr: false });
const ContextNode = dynamic(() => import('./nodes/ContextNode'), { ssr: false });
const BoardNode = dynamic(() => import('./nodes/BoardNode'), { ssr: false });

function nodeTitle(node: CanvasNode): string {
  switch (node.type) {
    case 'terminal':
      return String(node.payload.title ?? 'terminal');
    case 'browser':
      return String(node.payload.title || node.payload.url || 'browser');
    case 'context':
      return 'context';
    case 'board':
      return 'board';
    case 'note':
      return 'note';
    default:
      return String(node.payload.name ?? node.type);
  }
}

type BodyRenderers = Partial<Record<CanvasNodeType, React.ComponentType<{ node: CanvasNode; onPayload: (patch: Record<string, unknown>) => void }>>>;

const bodyRenderers: BodyRenderers = {
  note: NoteNode,
  text: TextNode,
  link: LinkNode,
  file: FileNode,
  image: ImageNode,
  media: MediaNode,
  html: HtmlNode,
  font: FontNode,
  terminal: TerminalNode,
  browser: BrowserNode,
  context: ContextNode,
  board: BoardNode
};

function disposeNode(node: CanvasNode) {
  if (node.type === 'terminal' && typeof node.payload.sessionId === 'string') {
    ptyKill(node.payload.sessionId);
  }
}

export function CanvasRoot() {
  const saveRef = useRef<() => void>(() => {});
  const camera = useCamera(() => saveRef.current());
  const workspace = useWorkspace(camera.getViewport);
  const [selected, setSelected] = useState<string | null>(null);
  const mouse = useRef({ x: 400, y: 300 });
  saveRef.current = workspace.scheduleSave;

  useEffect(() => {
    if (workspace.initialViewport) camera.setViewport(workspace.initialViewport);
  }, [workspace.initialViewport, camera]);

  const spawnSeeds = useCallback(
    (seeds: NodeSeed[], at: { x: number; y: number }) => {
      seeds.forEach((seed, i) => {
        const node = makeNode(seed, at.x + i * 28, at.y + i * 28, workspace.takeZ());
        workspace.addNode(node);
        setSelected(node.id);
      });
    },
    [workspace]
  );

  const spawn = useCallback(
    (type: CanvasNodeType, payload: Record<string, unknown> = {}) => {
      const center = camera.centerWorld();
      if (type === 'terminal' && !payload.cwd) payload = { ...payload, cwd: '/Users/ummi/hii' };
      const seed = seedFor(type, payload);
      spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 });
    },
    [camera, spawnSeeds]
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer) return;
      const at = camera.toWorld(e.clientX, e.clientY);
      spawnSeeds(await seedsFromDataTransfer(e.dataTransfer), at);
    },
    [camera, spawnSeeds]
  );

  useEffect(() => {
    const inField = (e: Event) => (e.target as Element)?.closest?.('input,textarea,[contenteditable]');
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e)) return;
      const at = camera.toWorld(mouse.current.x, mouse.current.y);
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        Promise.all(files.map((f) => seedFromFile(f))).then((seeds) => spawnSeeds(seeds, at));
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text) spawnSeeds([seedFromString(text)], at);
    };
    const onKey = (e: KeyboardEvent) => {
      if (inField(e)) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
        const node = workspace.nodes.find((n) => n.id === selected);
        if (node) disposeNode(node);
        workspace.removeNode(selected);
        setSelected(null);
      } else if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        camera.reset();
      }
    };
    const onMove = (e: PointerEvent) => {
      mouse.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onMove);
    };
  }, [camera, selected, spawnSeeds, workspace]);

  return (
    <div
      ref={camera.viewportRef}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('[data-node-id],[data-canvas-ui]')) return;
        setSelected(null);
        camera.panStart(e);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="absolute inset-0 touch-none overflow-hidden"
      style={{
        background:
          'var(--hii-warm-white) radial-gradient(circle, rgba(23,23,23,0.08) 1px, transparent 1px)',
        backgroundSize: '32px 32px'
      }}
    >
      <div ref={camera.worldRef} data-canvas-world className="absolute left-0 top-0 origin-top-left will-change-transform">
        {workspace.nodes.map((node) => {
          const Body = bodyRenderers[node.type];
          return (
            <NodeFrame
              key={node.id}
              node={node}
              selected={selected === node.id}
              title={nodeTitle(node)}
              getZoom={() => camera.cam.current.z}
              onSelect={() => {
                setSelected(node.id);
                workspace.bringToFront(node.id);
              }}
              onCommit={(patch) => workspace.patchNode(node.id, patch)}
              onClose={() => {
                disposeNode(node);
                workspace.removeNode(node.id);
                if (selected === node.id) setSelected(null);
              }}
            >
              {Body ? (
                <Body node={node} onPayload={(patch) => workspace.patchNode(node.id, { payload: { ...node.payload, ...patch } })} />
              ) : (
                <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">{node.type}</div>
              )}
            </NodeFrame>
          );
        })}
      </div>

      {workspace.ready && workspace.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid select-none place-items-center text-[13px] tracking-wide text-neutral-400">
          drop anything &nbsp;·&nbsp; ⌘K &nbsp;·&nbsp; scroll to pan &nbsp;·&nbsp; ⌘scroll to zoom &nbsp;·&nbsp; ⌫ delete &nbsp;·&nbsp; ⌘0 reset
        </div>
      )}

      <Dock spawn={spawn} />
      <CommandBar spawn={spawn} resetView={camera.reset} />
      <div data-canvas-ui className="pointer-events-none absolute left-5 top-4 select-none">
        <span className="font-mono text-[13px] font-semibold lowercase tracking-tight text-[var(--hii-graphite)]">hii</span>
        <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-neutral-400">canvas</span>
      </div>
    </div>
  );
}

function Dock({ spawn }: { spawn: (type: CanvasNodeType) => void }) {
  const items: Array<{ type: CanvasNodeType; label: string }> = [
    { type: 'terminal', label: 'terminal' },
    { type: 'browser', label: 'browser' },
    { type: 'note', label: 'note' },
    { type: 'context', label: 'context' },
    { type: 'board', label: 'board' }
  ];
  return (
    <div
      data-canvas-ui
      className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white px-2 py-1.5 shadow-[0_0_0_1px_rgba(23,23,23,0.12),0_8px_24px_rgba(23,23,23,0.08)]"
    >
      {items.map((item) => (
        <button
          key={item.type}
          onClick={() => spawn(item.type)}
          onPointerDown={(e) => e.stopPropagation()}
          className="rounded-full px-3 py-1 font-mono text-[11px] lowercase text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[var(--hii-graphite)]"
        >
          + {item.label}
        </button>
      ))}
    </div>
  );
}
