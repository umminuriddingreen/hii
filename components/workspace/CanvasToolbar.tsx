'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUpRight,
  CornersOut,
  Cursor,
  DotsThree,
  Export,
  FileArrowUp,
  MagnifyingGlass,
  Minus,
  Note,
  Path,
  PencilSimple,
  Plus,
  PresentationChart,
  Pulse,
  Shapes,
  Table,
  TerminalWindow,
  TextT
} from '@phosphor-icons/react';
import styles from './CanvasToolbar.module.css';

export type CanvasTool = 'select' | 'text' | 'sticky' | 'shape' | 'connector' | 'table' | 'draw' | 'media';

export type CanvasToolbarCapabilities = {
  scenes?: boolean;
  export?: boolean;
  nativeTerminal?: boolean;
  search?: boolean;
  activity?: boolean;
  remote?: boolean;
};

export type CanvasToolbarProps = {
  activeTool: CanvasTool;
  capabilities?: CanvasToolbarCapabilities;
  disabled?: boolean;
  onToolChange: (tool: CanvasTool) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitView?: () => void;
  onOpenScenes?: () => void;
  onExport?: () => void;
  onOpenTerminal?: () => void;
  onSearch?: () => void;
  onOpenActivity?: () => void;
  onOpenRemote?: () => void;
};

const tools: Array<{ id: CanvasTool; label: string; shortcut: string; icon: typeof Cursor }> = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: Cursor },
  { id: 'text', label: 'Text', shortcut: 'T', icon: TextT },
  { id: 'sticky', label: 'Sticky', shortcut: 'N', icon: Note },
  { id: 'shape', label: 'Shape', shortcut: 'S', icon: Shapes },
  { id: 'connector', label: 'Connector', shortcut: 'C', icon: Path },
  { id: 'table', label: 'Table', shortcut: 'B', icon: Table },
  { id: 'draw', label: 'Draw', shortcut: 'D', icon: PencilSimple },
  { id: 'media', label: 'Media', shortcut: '⌘U', icon: FileArrowUp }
];

export function CanvasToolbar({
  activeTool,
  capabilities = {},
  disabled = false,
  onToolChange,
  onZoomIn,
  onZoomOut,
  onFitView,
  onOpenScenes,
  onExport,
  onOpenTerminal,
  onSearch,
  onOpenActivity,
  onOpenRemote
}: CanvasToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shellRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: globalThis.KeyboardEvent | PointerEvent) => {
      if (event instanceof globalThis.KeyboardEvent && event.key === 'Escape') setMenuOpen(false);
      if (event instanceof PointerEvent && !shellRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, [menuOpen]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    event.preventDefault();
  };

  const run = (action?: () => void) => {
    action?.();
    setMenuOpen(false);
  };

  return <nav ref={shellRef} className={styles.shell} data-workspace-ui aria-label="Canvas tools" onPointerDown={(event) => event.stopPropagation()}>
    <div className={styles.tools} role="toolbar" aria-label="Create and edit" onKeyDown={moveFocus}>
      {tools.map(({ id, label, shortcut, icon: Icon }) => <button
        key={id}
        type="button"
        className={styles.tool}
        aria-label={`${label} · ${shortcut}`}
        aria-pressed={activeTool === id}
        disabled={disabled}
        onClick={() => onToolChange(id)}
      >
        <Icon size={18} weight={activeTool === id ? 'fill' : 'regular'} aria-hidden="true" />
        <span>{label}</span>
        <kbd>{shortcut}</kbd>
      </button>)}
      <span className={styles.divider} aria-hidden="true" />
      <button type="button" className={styles.more} aria-label="Canvas utilities" aria-expanded={menuOpen} aria-controls="hii-canvas-utilities" onClick={() => setMenuOpen((open) => !open)}>
        <DotsThree size={19} weight="bold" aria-hidden="true" />
        <span>More</span>
      </button>
    </div>
    {menuOpen && <section id="hii-canvas-utilities" className={styles.menu} aria-label="Canvas utilities">
      <div className={styles.menuGroup} role="group" aria-label="Zoom">
        <button type="button" onClick={() => run(onZoomOut)} disabled={!onZoomOut}><Minus size={16} aria-hidden="true" />Zoom out<kbd>−</kbd></button>
        <button type="button" onClick={() => run(onZoomIn)} disabled={!onZoomIn}><Plus size={16} aria-hidden="true" />Zoom in<kbd>+</kbd></button>
        <button type="button" onClick={() => run(onFitView)} disabled={!onFitView}><CornersOut size={16} aria-hidden="true" />Fit canvas<kbd>0</kbd></button>
      </div>
      {(capabilities.scenes || capabilities.export) && <div className={styles.menuGroup} role="group" aria-label="Canvas output">
        {capabilities.scenes && <button type="button" onClick={() => run(onOpenScenes)} disabled={!onOpenScenes}><PresentationChart size={16} aria-hidden="true" />Scenes</button>}
        {capabilities.export && <button type="button" onClick={() => run(onExport)} disabled={!onExport}><Export size={16} aria-hidden="true" />Export</button>}
      </div>}
      <div className={styles.menuGroup} role="group" aria-label="HII utilities">
        {capabilities.nativeTerminal && <button type="button" onClick={() => run(onOpenTerminal)} disabled={!onOpenTerminal}><TerminalWindow size={16} aria-hidden="true" />Terminal</button>}
        {capabilities.search && <button type="button" onClick={() => run(onSearch)} disabled={!onSearch}><MagnifyingGlass size={16} aria-hidden="true" />Search</button>}
        {capabilities.activity && <button type="button" onClick={() => run(onOpenActivity)} disabled={!onOpenActivity}><Pulse size={16} aria-hidden="true" />Activity</button>}
        {capabilities.remote && <button type="button" onClick={() => run(onOpenRemote)} disabled={!onOpenRemote}><ArrowUpRight size={16} aria-hidden="true" />HII Remote</button>}
      </div>
    </section>}
  </nav>;
}
