'use client';

import { FormEvent, useMemo, useState } from 'react';

export function SpaceToolbar({
  drawing,
  photo,
  accountTools = false,
  commandsOpen,
  status = '',
  onAddText,
  onAddNote,
  onAddSticker,
  onAddImage,
  onAddLink,
  onOpenTerminal,
  onUndo,
  onRedo,
  onFitView,
  onArrangeImages,
  onZoomIn,
  onZoomOut,
  onDeleteSelection,
  onShareSelection,
  selectionCount = 0,
  onCommandsOpenChange,
  onToggleDrawing
}: {
  drawing: boolean;
  photo: boolean;
  accountTools?: boolean;
  commandsOpen?: boolean;
  status?: string;
  onAddText: () => void;
  onAddNote?: () => void;
  onAddSticker: () => void;
  onAddImage: () => void;
  onAddLink?: (url: string) => void;
  onOpenTerminal?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onFitView?: () => void;
  onArrangeImages?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onDeleteSelection?: () => void;
  onShareSelection?: () => void;
  selectionCount?: number;
  onCommandsOpenChange?: (open: boolean) => void;
  onToggleDrawing: () => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const expanded = commandsOpen ?? localExpanded;
  const setExpanded = (open: boolean) => {
    setLocalExpanded(open);
    if (!open) setQuery('');
    onCommandsOpenChange?.(open);
  };

  const run = (action?: () => void) => {
    action?.();
    setExpanded(false);
  };

  const commands = useMemo(() => [
    { label: 'Add text', shortcut: 'T', keywords: 'write type', action: onAddText },
    { label: 'Add note', shortcut: 'N', keywords: 'sticky write', action: onAddNote },
    { label: drawing ? 'Stop drawing' : 'Draw', shortcut: 'D', keywords: 'ink pen', action: onToggleDrawing },
    ...(photo ? [{ label: 'Add file', shortcut: '⌘U', keywords: 'upload image media document', action: onAddImage }] : []),
    { label: 'Fit canvas', shortcut: '0', keywords: 'view zoom show all', action: onFitView },
    ...(onArrangeImages ? [{ label: 'Arrange images', shortcut: '', keywords: 'parametric layout grid field chronology constellation portfolio', action: onArrangeImages }] : []),
    ...(onZoomIn ? [{ label: 'Zoom in', shortcut: '⌘=', keywords: 'view closer magnify scale', action: onZoomIn }] : []),
    ...(onZoomOut ? [{ label: 'Zoom out', shortcut: '⌘−', keywords: 'view wider shrink scale', action: onZoomOut }] : []),
    { label: 'Undo', shortcut: '⌘Z', keywords: 'back history', action: onUndo },
    { label: 'Redo', shortcut: '⇧⌘Z', keywords: 'forward history', action: onRedo },
    { label: 'HII Remote', shortcut: '', keywords: 'device computer remote local model', action: onOpenTerminal },
    ...(selectionCount ? [{ label: `Delete selected (${selectionCount})`, shortcut: 'Delete', keywords: 'remove selection', action: onDeleteSelection }] : []),
    ...(selectionCount === 1 && onShareSelection ? [{ label: 'Share selected', shortcut: '', keywords: 'publish feed', action: onShareSelection }] : [])
  ], [drawing, onAddImage, onAddNote, onAddText, onArrangeImages, onDeleteSelection, onFitView, onOpenTerminal, onRedo, onShareSelection, onToggleDrawing, onUndo, onZoomIn, onZoomOut, photo, selectionCount]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCommands = normalizedQuery
    ? commands.filter((command) => `${command.label} ${command.shortcut} ${command.keywords}`.toLowerCase().includes(normalizedQuery))
    : commands;

  const addLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('unsupported protocol');
      onAddLink?.(parsed.href);
      setUrl('');
      setMessage('');
      setExpanded(false);
    } catch {
      setMessage('use an http or https address.');
    }
  };

  return <nav className="hii-space-toolbar" data-account-tools={accountTools || undefined} data-workspace-ui aria-label={accountTools ? 'Canvas tools' : 'Space tools'} onPointerDown={(event) => event.stopPropagation()}>
    {!accountTools && <strong>hii space</strong>}
    {accountTools ? <>
      <button className="hii-canvas-command-trigger" type="button" aria-label="Canvas commands" aria-expanded={expanded} aria-controls="hii-account-tools" onClick={() => setExpanded(!expanded)}>
        <span aria-hidden="true">?</span>
      </button>
      <div className="hii-canvas-touch-tools">
        {photo && <button type="button" onClick={onAddImage}>file</button>}
        <button type="button" onClick={onAddText}>text</button>
        <button type="button" onClick={onAddNote}>note</button>
        <button type="button" aria-pressed={drawing} onClick={onToggleDrawing}>{drawing ? 'drawing…' : 'draw'}</button>
        <button type="button" aria-expanded={expanded} aria-controls="hii-account-tools" onClick={() => setExpanded(!expanded)}>more</button>
      </div>
    </> : <>
      {photo && <button type="button" onClick={onAddImage}>photo</button>}
      <button type="button" onClick={onAddText}>text</button>
      <button type="button" onClick={onAddSticker}>sticker</button>
      <button type="button" aria-pressed={drawing} onClick={onToggleDrawing}>{drawing ? 'drawing…' : 'draw'}</button>
    </>}
    {accountTools && expanded && <section id="hii-account-tools" className="hii-account-tools" aria-label="Canvas commands">
      <form className="hii-canvas-command-search" onSubmit={(event) => { event.preventDefault(); run(visibleCommands[0]?.action); }}>
        <input aria-label="Search canvas commands" autoComplete="off" autoFocus placeholder="Search commands" value={query} onChange={(event) => setQuery(event.target.value)} />
      </form>
      <ul className="hii-canvas-command-list">
        {visibleCommands.map((command) => <li key={`${command.label}:${command.shortcut}`}><button type="button" onClick={() => run(command.action)}>
          <span>{command.label}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}
        </button></li>)}
        {!visibleCommands.length && <li><small>No matching command.</small></li>}
      </ul>
      <div className="hii-canvas-touch-secondary">
        <button type="button" onClick={onUndo}>undo</button>
        <button type="button" onClick={onRedo}>redo</button>
        <button type="button" onClick={onFitView}>fit canvas</button>
        <button type="button" onClick={onOpenTerminal}>HII Remote</button>
      </div>
      <form className="hii-canvas-touch-link" onSubmit={addLink}>
        <input aria-label="Web address" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} required />
        <button type="submit">add link</button>
      </form>
      {(message || status) && <small role="status">{message || status}</small>}
    </section>}
  </nav>;
}
