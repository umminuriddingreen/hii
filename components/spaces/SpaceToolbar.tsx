'use client';

import { FormEvent, useState } from 'react';

export function SpaceToolbar({
  drawing,
  photo,
  accountTools = false,
  status = '',
  onAddText,
  onAddSticker,
  onAddImage,
  onAddLink,
  onOpenTerminal,
  onUndo,
  onRedo,
  onResetView,
  onToggleDrawing
}: {
  drawing: boolean;
  photo: boolean;
  accountTools?: boolean;
  status?: string;
  onAddText: () => void;
  onAddSticker: () => void;
  onAddImage: () => void;
  onAddLink?: (url: string) => void;
  onOpenTerminal?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onResetView?: () => void;
  onToggleDrawing: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');

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

  return <nav className="hii-space-toolbar" data-workspace-ui aria-label="Space tools" onPointerDown={(event) => event.stopPropagation()}>
    <strong>{accountTools ? 'HII Canvas' : 'HII Space'}</strong>
    {accountTools && <button type="button" onClick={onOpenTerminal}><span>Terminal</span><kbd>Space</kbd></button>}
    {photo && <button type="button" onClick={onAddImage}><span>{accountTools ? 'Upload' : 'Photo'}</span>{accountTools && <kbd>⌘U</kbd>}</button>}
    <button type="button" onClick={onAddText}><span>Text</span>{accountTools && <kbd>T</kbd>}</button>
    {!accountTools && <button type="button" onClick={onAddSticker}>Sticker</button>}
    <button type="button" aria-pressed={drawing} onClick={onToggleDrawing}><span>{drawing ? 'Drawing...' : 'Draw'}</span>{accountTools && <kbd>D</kbd>}</button>
    {accountTools && <button type="button" aria-expanded={expanded} aria-controls="hii-account-tools" onClick={() => setExpanded((value) => !value)}>More</button>}
    {accountTools && expanded && <section id="hii-account-tools" className="hii-account-tools" aria-label="More canvas tools">
      <div>
        <button type="button" onClick={onUndo}>undo</button>
        <button type="button" onClick={onRedo}>redo</button>
        <button type="button" onClick={onResetView}>reset view</button>
      </div>
      <form onSubmit={addLink}>
        <input aria-label="Web address" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} required />
        <button type="submit">add link</button>
      </form>
      {(message || status) && <small role="status">{message || status}</small>}
      <small>files stay on this device. terminal access requires a trusted HII device.</small>
    </section>}
  </nav>;
}
