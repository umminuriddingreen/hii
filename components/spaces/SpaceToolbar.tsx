'use client';

import { FormEvent, useState } from 'react';

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
  onResetView,
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
  onResetView?: () => void;
  onCommandsOpenChange?: (open: boolean) => void;
  onToggleDrawing: () => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const expanded = commandsOpen ?? localExpanded;
  const setExpanded = (open: boolean) => {
    setLocalExpanded(open);
    onCommandsOpenChange?.(open);
  };

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
    <strong>{accountTools ? 'hii canvas' : 'hii space'}</strong>
    {accountTools ? <>
      <button className="hii-canvas-command-trigger" type="button" aria-expanded={expanded} aria-controls="hii-account-tools" onClick={() => setExpanded(!expanded)}>
        <span>commands</span><kbd>?</kbd>
      </button>
      <div className="hii-canvas-touch-tools">
        {photo && <button type="button" onClick={onAddImage}>media</button>}
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
    {accountTools && expanded && <section id="hii-account-tools" className="hii-account-tools" aria-label="More canvas tools">
      <dl className="hii-canvas-shortcuts" aria-label="Canvas keyboard commands">
        <div><dt>space</dt><dd>device terminal</dd></div>
        <div><dt>t</dt><dd>text</dd></div>
        <div><dt>n</dt><dd>note</dd></div>
        <div><dt>d</dt><dd>draw</dd></div>
        <div><dt>⌘u</dt><dd>media or file</dd></div>
        <div><dt>⌘z</dt><dd>undo</dd></div>
        <div><dt>⇧⌘z</dt><dd>redo</dd></div>
        <div><dt>0</dt><dd>reset view</dd></div>
        <div><dt>delete</dt><dd>remove selected</dd></div>
        <div><dt>esc</dt><dd>leave tool</dd></div>
      </dl>
      <div className="hii-canvas-touch-secondary">
        <button type="button" onClick={onUndo}>undo</button>
        <button type="button" onClick={onRedo}>redo</button>
        <button type="button" onClick={onResetView}>reset view</button>
        <button type="button" onClick={onOpenTerminal}>devices</button>
      </div>
      <form onSubmit={addLink}>
        <input aria-label="Web address" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} required />
        <button type="submit">add link</button>
      </form>
      {(message || status) && <small role="status">{message || status}</small>}
      <small>double-click for text. paste or drop anything. drag to move; option-drag to resize. files stay on this device.</small>
    </section>}
  </nav>;
}
