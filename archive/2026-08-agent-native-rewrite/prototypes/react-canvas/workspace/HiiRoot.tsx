'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion';
import type { WorkspaceNode, WorkspaceNodeType } from '../../lib/workspace/types';
import { makeNode, seedFor, seedsFromDataTransfer, seedFromFile, seedFromString, type NodeSeed } from '../../lib/workspace/ingest';
import { useCamera } from './useCamera';
import { useWorkspace } from './useWorkspace';
import { NodeFrame } from './NodeFrame';
import { CommandBar } from './CommandBar';
import { DaemonButton } from './DaemonButton';
import { HiiLogo } from '../brand/HiiLogo';
import { FileNode, FontNode, HtmlNode, ImageNode, LinkNode, MediaNode, NoteNode, TextNode } from './nodes/StaticNodes';
import { CanvasTextNode, InkNode } from './nodes/CreativeNodes';
import { ptyKill } from './usePtySocket';

const TerminalNode = dynamic(() => import('./nodes/TerminalNode'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">starting terminal…</div>
});
const BrowserNode = dynamic(() => import('./nodes/BrowserNode'), { ssr: false });
const ContextNode = dynamic(() => import('./nodes/ContextNode'), { ssr: false });
const BoardNode = dynamic(() => import('./nodes/BoardNode'), { ssr: false });
const ChatNode = dynamic(() => import('./nodes/ChatNode'), { ssr: false });
const SouthBerkeleySoundFieldNode = dynamic(() => import('./nodes/SouthBerkeleySoundFieldNode'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center bg-[#071018] font-mono text-[11px] text-[#8ba2ad]">building sound field…</div>
});

function nodeTitle(node: WorkspaceNode): string {
  switch (node.type) {
    case 'chat':
      return 'chat';
    case 'terminal':
      return String(node.payload.title ?? 'terminal');
    case 'browser':
      return String(node.payload.title || node.payload.url || 'browser');
    case 'context':
      return 'context';
    case 'board':
      return 'board';
    case 'sound-field':
      return String(node.payload.title || 'South Berkeley Sound Field');
    case 'note':
      return 'note';
    default:
      return String(node.payload.name ?? node.type);
  }
}

type BodyRenderers = Partial<Record<WorkspaceNodeType, React.ComponentType<{ node: WorkspaceNode; onPayload: (patch: Record<string, unknown>) => void }>>>;

const bodyRenderers: BodyRenderers = {
  chat: ChatNode,
  note: NoteNode,
  text: TextNode,
  'canvas-text': CanvasTextNode,
  ink: InkNode,
  link: LinkNode,
  file: FileNode,
  image: ImageNode,
  media: MediaNode,
  html: HtmlNode,
  font: FontNode,
  terminal: TerminalNode,
  browser: BrowserNode,
  context: ContextNode,
  board: BoardNode,
  'sound-field': SouthBerkeleySoundFieldNode
};

type CanvasTool = 'select' | 'text' | 'pen' | 'marker' | 'eraser';
type Point = { x: number; y: number };

function pointsPath(points: Point[]) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function disposeNode(node: WorkspaceNode) {
  if (node.type === 'terminal' && typeof node.payload.sessionId === 'string') {
    ptyKill(node.payload.sessionId);
  }
}

export function HiiRoot() {
  const saveRef = useRef<() => void>(() => {});
  const camera = useCamera(() => saveRef.current());
  const workspace = useWorkspace(camera.getViewport);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [inkColor, setInkColor] = useState('#171717');
  const [inkWidth, setInkWidth] = useState(4);
  const [previewStroke, setPreviewStroke] = useState<Point[]>([]);
  const [omnibarOpen, setOmnibarOpen] = useState(false);
  const mouse = useRef({ x: 400, y: 300 });
  const getOmnibarAnchor = useCallback(() => mouse.current, []);
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
    (type: WorkspaceNodeType, payload: Record<string, unknown> = {}) => {
      const center = camera.centerWorld();
      const seed = seedFor(type, payload);
      spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 });
    },
    [camera, spawnSeeds]
  );

  const pinDaemonEvent = useCallback(
    (event: { ts: string; type: string; status?: string; text?: string; loop?: string; target?: string }) => {
      const center = camera.centerWorld();
      const title = `${event.type}${event.status ? ` · ${event.status}` : ''}`;
      const content = [
        title,
        event.text || event.target || '',
        event.loop ? `loop: ${event.loop}` : '',
        event.ts
      ]
        .filter(Boolean)
        .join('\n');
      spawnSeeds([seedFor('note', { title, content })], { x: center.x - 140, y: center.y - 100 });
    },
    [camera, spawnSeeds]
  );

  const undoInk = useCallback(() => {
    const last = [...workspace.nodes]
      .filter((node) => node.type === 'ink')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (last) workspace.removeNode(last.id);
  }, [workspace]);

  const beginInk = useCallback((event: React.PointerEvent) => {
    const screenPoints: Point[] = [{ x: event.clientX, y: event.clientY }];
    const worldPoints: Point[] = [camera.toWorld(event.clientX, event.clientY)];
    setPreviewStroke(screenPoints);
    const move = (next: PointerEvent) => {
      const previous = screenPoints[screenPoints.length - 1];
      if (Math.hypot(next.clientX - previous.x, next.clientY - previous.y) < 1.5) return;
      screenPoints.push({ x: next.clientX, y: next.clientY });
      worldPoints.push(camera.toWorld(next.clientX, next.clientY));
      setPreviewStroke([...screenPoints]);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setPreviewStroke([]);
      if (worldPoints.length < 2) return;
      const width = tool === 'marker' ? Math.max(12, inkWidth * 3) : inkWidth;
      const pad = width * 2 + 2;
      const xs = worldPoints.map((point) => point.x);
      const ys = worldPoints.map((point) => point.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const nodeWidth = Math.max(40, Math.max(...xs) - minX + pad * 2);
      const nodeHeight = Math.max(28, Math.max(...ys) - minY + pad * 2);
      spawnSeeds([{
        type: 'ink',
        w: nodeWidth,
        h: nodeHeight,
        payload: {
          points: worldPoints.map((point) => ({ x: point.x - minX + pad, y: point.y - minY + pad })),
          color: inkColor,
          width,
          opacity: tool === 'marker' ? 0.32 : 1,
          tool
        }
      }], { x: minX - pad, y: minY - pad });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }, [camera, inkColor, inkWidth, spawnSeeds, tool]);

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
      if (omnibarOpen) return;
      if (inField(e)) return;
      const at = camera.toWorld(mouse.current.x, mouse.current.y);
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) {
        for (const item of [...(e.clipboardData?.items || [])]) {
          const file = item.kind === 'file' ? item.getAsFile() : null;
          if (file) files.push(file);
        }
      }
      if (files.length) {
        e.preventDefault();
        Promise.all(files.map((f) => seedFromFile(f))).then((seeds) => spawnSeeds(seeds, at));
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text) spawnSeeds([seedFromString(text)], at);
    };
    const onKey = (e: KeyboardEvent) => {
      if (omnibarOpen) return;
      if (inField(e)) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
        const node = workspace.nodes.find((n) => n.id === selected);
        if (node) disposeNode(node);
        workspace.removeNode(selected);
        setSelected(null);
      } else if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        camera.reset();
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const shortcuts: Partial<Record<string, CanvasTool>> = { v: 'select', t: 'text', p: 'pen', m: 'marker', e: 'eraser' };
        const nextTool = shortcuts[e.key.toLowerCase()];
        if (nextTool) setTool(nextTool);
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
  }, [camera, omnibarOpen, selected, spawnSeeds, workspace]);

  useEffect(() => {
    const onMediaFile = (event: Event) => {
      const file = (event as CustomEvent<File>).detail;
      if (!(file instanceof File)) return;
      const center = camera.centerWorld();
      seedFromFile(file).then((seed) => spawnSeeds([seed], { x: center.x - seed.w / 2, y: center.y - seed.h / 2 }));
    };
    window.addEventListener('hii:media-file', onMediaFile);
    return () => window.removeEventListener('hii:media-file', onMediaFile);
  }, [camera, spawnSeeds]);

  return (
    <div
      ref={camera.viewportRef}
      data-workspace-paused={omnibarOpen ? 'true' : undefined}
      onPointerDown={(e) => {
        if (omnibarOpen) return;
        if ((e.target as Element).closest('[data-node-id],[data-workspace-ui]')) return;
        setSelected(null);
        if (tool === 'text') {
          const at = camera.toWorld(e.clientX, e.clientY);
          spawnSeeds([seedFor('canvas-text', { text: '', autofocus: true, color: inkColor })], at);
          setTool('select');
        } else if (tool === 'pen' || tool === 'marker') {
          e.preventDefault();
          beginInk(e);
        } else if (tool !== 'eraser') {
          camera.panStart(e);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className={`absolute inset-0 touch-none overflow-hidden ${tool === 'text' ? 'cursor-text' : tool === 'pen' || tool === 'marker' ? 'cursor-crosshair' : tool === 'eraser' ? 'cursor-cell' : ''}`}
      style={{
        background:
          'var(--hii-warm-white) radial-gradient(circle, rgba(23,23,23,0.08) 1px, transparent 1px)',
        backgroundSize: '32px 32px'
      }}
    >
      <div ref={camera.worldRef} data-workspace-world className={`absolute left-0 top-0 origin-top-left will-change-transform ${omnibarOpen ? 'hii-workspace-suspended' : ''}`}>
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
              chromeless={node.type === 'canvas-text' || node.type === 'ink'}
              onErase={tool === 'eraser' && node.type === 'ink' ? () => {
                workspace.removeNode(node.id);
                if (selected === node.id) setSelected(null);
              } : undefined}
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

      {previewStroke.length > 1 && (
        <svg className="pointer-events-none absolute inset-0 z-40 h-full w-full" aria-hidden="true">
          <path d={pointsPath(previewStroke)} fill="none" stroke={inkColor} strokeWidth={tool === 'marker' ? Math.max(12, inkWidth * 3) : inkWidth} strokeLinecap="round" strokeLinejoin="round" opacity={tool === 'marker' ? 0.32 : 1} />
        </svg>
      )}

      {workspace.ready && workspace.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid select-none place-items-center text-[13px] tracking-wide text-neutral-400">
          paste or drop media &nbsp;·&nbsp; T type &nbsp;·&nbsp; P draw &nbsp;·&nbsp; ⌘K commands &nbsp;·&nbsp; ⌘scroll zoom
        </div>
      )}

      <CreativeRail
        tool={tool}
        setTool={setTool}
        spawn={spawn}
        inkColor={inkColor}
        setInkColor={setInkColor}
        inkWidth={inkWidth}
        setInkWidth={setInkWidth}
        undoInk={undoInk}
        addMedia={(files) => {
          const center = camera.centerWorld();
          Promise.all(files.map(seedFromFile)).then((seeds) => spawnSeeds(seeds, { x: center.x - 190, y: center.y - 150 }));
        }}
      />
      <Dock spawn={spawn} />
      <CommandBar spawn={spawn} resetView={camera.reset} getAnchor={getOmnibarAnchor} onOpenChange={setOmnibarOpen} />
      <DaemonButton onPin={pinDaemonEvent} />
      <div data-workspace-ui className="pointer-events-none absolute left-5 top-4 select-none">
        <HiiLogo className="h-4 w-auto text-[var(--hii-graphite)]" />
      </div>
    </div>
  );
}

function CreativeRail({
  tool,
  setTool,
  spawn,
  inkColor,
  setInkColor,
  inkWidth,
  setInkWidth,
  undoInk,
  addMedia
}: {
  tool: CanvasTool;
  setTool: (tool: CanvasTool) => void;
  spawn: (type: WorkspaceNodeType) => void;
  inkColor: string;
  setInkColor: (color: string) => void;
  inkWidth: number;
  setInkWidth: (width: number) => void;
  undoInk: () => void;
  addMedia: (files: File[]) => void;
}) {
  const tools: Array<{ id: CanvasTool; glyph: string; label: string; shortcut: string }> = [
    { id: 'select', glyph: '↖', label: 'select', shortcut: 'V' },
    { id: 'text', glyph: 'T', label: 'text', shortcut: 'T' },
    { id: 'pen', glyph: '∿', label: 'pen', shortcut: 'P' },
    { id: 'marker', glyph: '▰', label: 'marker', shortcut: 'M' },
    { id: 'eraser', glyph: '◇', label: 'eraser', shortcut: 'E' }
  ];
  return (
    <div data-workspace-ui className="absolute left-4 top-12 z-50 flex items-start gap-2" onPointerDown={(event) => event.stopPropagation()}>
      <div className="flex w-11 flex-col items-center gap-1 rounded-[14px] bg-neutral-950 p-1.5 shadow-[0_12px_36px_rgba(23,23,23,0.22)]">
        <button type="button" onClick={() => spawn('chat')} className="group/tool relative grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--hii-electric-blue)] text-[15px] text-white" aria-label="Open chat" title="Chat">
          ✦
          <span className="pointer-events-none absolute left-10 rounded bg-neutral-950 px-2 py-1 font-mono text-[9px] text-white opacity-0 shadow-lg transition-opacity group-hover/tool:opacity-100">chat</span>
        </button>
        <div className="my-0.5 h-px w-6 bg-white/15" />
        {tools.map((item) => (
          <button key={item.id} type="button" onClick={() => setTool(item.id)} className={`group/tool relative grid h-8 w-8 place-items-center rounded-[9px] font-mono text-[14px] transition ${tool === item.id ? 'bg-white text-neutral-950' : 'text-neutral-400 hover:bg-white/10 hover:text-white'}`} aria-label={`${item.label} tool`} title={`${item.label} (${item.shortcut})`}>
            {item.glyph}
            <span className="pointer-events-none absolute left-10 whitespace-nowrap rounded bg-neutral-950 px-2 py-1 font-mono text-[9px] text-white opacity-0 shadow-lg transition-opacity group-hover/tool:opacity-100">{item.label} · {item.shortcut}</span>
          </button>
        ))}
        <label className="group/tool relative grid h-8 w-8 cursor-pointer place-items-center rounded-[9px] font-mono text-[15px] text-neutral-400 hover:bg-white/10 hover:text-white" title="Add media">
          ⊕
          <span className="pointer-events-none absolute left-10 whitespace-nowrap rounded bg-neutral-950 px-2 py-1 font-mono text-[9px] text-white opacity-0 shadow-lg transition-opacity group-hover/tool:opacity-100">add media</span>
          <input type="file" multiple className="sr-only" onChange={(event) => {
            addMedia([...(event.target.files || [])]);
            event.target.value = '';
          }} />
        </label>
        <button type="button" onClick={undoInk} className="group/tool relative grid h-8 w-8 place-items-center rounded-[9px] font-mono text-[15px] text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Undo last stroke" title="Undo last stroke">
          ↶
          <span className="pointer-events-none absolute left-10 whitespace-nowrap rounded bg-neutral-950 px-2 py-1 font-mono text-[9px] text-white opacity-0 shadow-lg transition-opacity group-hover/tool:opacity-100">undo stroke</span>
        </button>
      </div>
      {(tool === 'pen' || tool === 'marker' || tool === 'text') && (
        <div className="w-44 rounded-xl bg-white p-3 shadow-[0_0_0_1px_rgba(23,23,23,0.1),0_12px_40px_rgba(23,23,23,0.14)]">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-400">{tool}</div>
          <div className="mt-2 flex gap-1.5">
            {['#171717', '#2f6bff', '#e83e5b', '#f2b705', '#ffffff'].map((color) => (
              <button key={color} type="button" onClick={() => setInkColor(color)} className={`h-6 w-6 rounded-full shadow-[0_0_0_1px_rgba(23,23,23,0.18)] ${inkColor === color ? 'ring-2 ring-[var(--hii-electric-blue)] ring-offset-2' : ''}`} style={{ backgroundColor: color }} aria-label={`Use ${color}`} />
            ))}
          </div>
          {tool !== 'text' && (
            <label className="mt-3 grid grid-cols-[1fr_28px] items-center gap-2 font-mono text-[9px] text-neutral-500">
              <input type="range" min="1" max="18" value={inkWidth} onChange={(event) => setInkWidth(Number(event.target.value))} className="accent-[var(--hii-electric-blue)]" />
              {inkWidth}px
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function Dock({ spawn }: { spawn: (type: WorkspaceNodeType) => void }) {
  const reduceMotion = useReducedMotion();
  const magneticX = useMotionValue(0);
  const magneticY = useMotionValue(0);
  const x = useSpring(magneticX, { stiffness: 280, damping: 28, mass: 0.65 });
  const y = useSpring(magneticY, { stiffness: 300, damping: 26, mass: 0.65 });
  const items: Array<{ type: WorkspaceNodeType; label: string }> = [
    { type: 'terminal', label: 'terminal' },
    { type: 'browser', label: 'browser' },
    { type: 'note', label: 'note' },
    { type: 'context', label: 'context' },
    { type: 'board', label: 'board' },
    { type: 'sound-field', label: 'sound field' }
  ];

  useEffect(() => {
    if (reduceMotion) return;
    const follow = (event: PointerEvent) => {
      const distanceFromBottom = window.innerHeight - event.clientY;
      const pull = Math.max(0, Math.min(1, (150 - distanceFromBottom) / 105));
      const offset = Math.max(-30, Math.min(30, (event.clientX - window.innerWidth / 2) * 0.075));
      magneticX.set(offset * pull);
      magneticY.set(-5 * pull);
    };
    const settle = () => {
      magneticX.set(0);
      magneticY.set(0);
    };
    window.addEventListener('pointermove', follow);
    window.addEventListener('blur', settle);
    return () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('blur', settle);
    };
  }, [magneticX, magneticY, reduceMotion]);

  return (
    <div
      data-workspace-ui
      data-testid="hii-context-dock"
      className="absolute bottom-5 left-1/2 -translate-x-1/2"
    >
      <motion.div
        className="flex items-center gap-1 rounded-full bg-white px-2 py-1.5 shadow-[0_0_0_1px_rgba(23,23,23,0.12),0_8px_24px_rgba(23,23,23,0.08)]"
        style={{ x, y }}
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
      </motion.div>
    </div>
  );
}
