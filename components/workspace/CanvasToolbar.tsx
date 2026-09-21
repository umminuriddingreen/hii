'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { commandShortcutFromEvent, type CommandShortcut } from '@/lib/workspace/command-shortcut';
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
  open?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  onOpenSiteViews?: () => void;
  onOpenParameters?: () => void;
  onRequestFeature?: (title: string) => Promise<string>;
  onStartWork?: (intent: string) => void;
  selectionLabels?: string[];
  workUnavailableReason?: string;
  shortcutLabel?: string;
  onShortcutChange?: (shortcut: CommandShortcut) => void;
};

const toolCommands: Array<{ label: string; shortcut: string; id: CanvasTool; keywords: string }> = [
  { label: 'Select', shortcut: 'V', id: 'select', keywords: 'cursor move' },
  { label: 'Text', shortcut: 'T', id: 'text', keywords: 'write type' },
  { label: 'Note', shortcut: 'N', id: 'sticky', keywords: 'sticky' },
  { label: 'Shape', shortcut: 'S', id: 'shape', keywords: 'rectangle ellipse' },
  { label: 'Connect', shortcut: 'C', id: 'connector', keywords: 'line link' },
  { label: 'Table', shortcut: 'B', id: 'table', keywords: 'grid' },
  { label: 'Draw', shortcut: 'D', id: 'draw', keywords: 'pen ink' },
  { label: 'Import file', shortcut: '⌘U', id: 'media', keywords: 'image media upload' }
];

export function CanvasToolbar({
  activeTool, capabilities = {}, open, disabled = false, onOpenChange, onToolChange,
  onZoomIn, onZoomOut, onFitView, onOpenScenes, onExport, onOpenTerminal,
  onSearch, onOpenActivity, onOpenRemote, onOpenSiteViews, onOpenParameters,
  onRequestFeature, onStartWork, selectionLabels = [], workUnavailableReason, shortcutLabel = '⌘K', onShortcutChange
}: CanvasToolbarProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [featureDraft, setFeatureDraft] = useState<string | null>(null);
  const [featureBusy, setFeatureBusy] = useState(false);
  const [shortcutCapture, setShortcutCapture] = useState(false);
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const expanded = open ?? localOpen;
  const setExpanded = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
    if (!value) { setQuery(''); setFeatureDraft(null); setShortcutCapture(false); setMessage(''); setIndex(0); }
  };

  useEffect(() => { if (expanded && !shortcutCapture) input.current?.focus(); }, [expanded, featureDraft, shortcutCapture]);

  const commands = useMemo(() => {
    const items = toolCommands.map((tool) => ({ ...tool, run: () => onToolChange(tool.id) }));
    const add = (label: string, keywords: string, run?: () => void, shortcut = '') => {
      if (run) items.push({ label, keywords, shortcut, id: 'select' as CanvasTool, run });
    };
    add('Fit canvas', 'view center reset zoom', onFitView, '0');
    add('Zoom in', 'view enlarge', onZoomIn, '+');
    add('Zoom out', 'view shrink', onZoomOut, '−');
    if (capabilities.scenes) add('Scenes', 'presentation', onOpenScenes);
    if (capabilities.export) add('Export selection', 'download save', onExport);
    if (capabilities.nativeTerminal) add('Terminal', 'hii cli shell', onOpenTerminal);
    if (capabilities.search) add('Search', 'find', onSearch);
    if (capabilities.activity) add('Activity', 'runs receipts', onOpenActivity);
    if (capabilities.remote) add('HII Remote', 'computer device model', onOpenRemote);
    add('Site views', 'website browser portfolio', onOpenSiteViews);
    add('Image parameters', 'layout arrange images', onOpenParameters);
    if (onRequestFeature) add('Request a feature', 'feedback idea suggestion board', () => setFeatureDraft(''));
    if (onShortcutChange) add('Set command shortcut', 'keyboard hotkey', () => setShortcutCapture(true));
    return items;
  }, [capabilities.activity, capabilities.export, capabilities.nativeTerminal, capabilities.remote, capabilities.scenes, capabilities.search, onExport, onFitView, onOpenActivity, onOpenParameters, onOpenRemote, onOpenScenes, onOpenSiteViews, onOpenTerminal, onRequestFeature, onSearch, onShortcutChange, onToolChange, onZoomIn, onZoomOut]);
  const visible = commands.filter((command) => `${command.label} ${command.keywords} ${command.shortcut}`.toLowerCase().includes(query.trim().toLowerCase()));
  const workIntent = query.trim();
  const showStartWork = Boolean(onStartWork && workIntent);
  const resultCount = visible.length + Number(showStartWork);
  const run = (action: () => void, label: string) => {
    if (label === 'Request a feature' || label === 'Set command shortcut') { action(); setQuery(''); return; }
    action();
    setExpanded(false);
  };
  const onKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, Math.max(0, resultCount - 1))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter' && showStartWork && workIntent && index === 0 && !visible.some((command) => command.label.toLowerCase() === workIntent.toLowerCase())) {
      event.preventDefault(); onStartWork?.(workIntent); setExpanded(false);
    }
    else if (event.key === 'Enter' && visible[index]) { event.preventDefault(); run(visible[index].run, visible[index].label); }
    else if (event.key === 'Enter' && showStartWork && index === visible.length) { event.preventDefault(); onStartWork?.(workIntent); setExpanded(false); }
  };
  const saveFeature = async () => {
    const title = featureDraft?.trim() || '';
    if (!onRequestFeature || title.length < 2 || featureBusy) return;
    setFeatureBusy(true);
    setMessage('');
    try {
      setMessage(await onRequestFeature(title));
      setFeatureDraft(null);
      setQuery('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the feature request.');
    } finally { setFeatureBusy(false); }
  };

  return <nav className={styles.shell} data-workspace-ui aria-label="Information terminal" onPointerDown={(event) => event.stopPropagation()}>
    <button className={styles.trigger} type="button" aria-label="Open information terminal" aria-expanded={expanded} aria-controls="hii-information-terminal" onClick={() => setExpanded(!expanded)}>
      <span>hii</span><kbd aria-hidden="true">{shortcutLabel}</kbd>
    </button>
    {expanded && <section id="hii-information-terminal" className={styles.palette} aria-label="Information terminal">
      {shortcutCapture ? <div className={styles.shortcutCapture}>
        <label htmlFor="hii-command-shortcut">Press a shortcut</label>
        <input id="hii-command-shortcut" autoFocus readOnly value="" placeholder="Hold ⌘, ⌥, or ⌃ and press a key" onKeyDown={(event) => {
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') { setShortcutCapture(false); return; }
          const shortcut = commandShortcutFromEvent(event.nativeEvent);
          if (!shortcut) { setMessage('Use ⌘, ⌥, or ⌃ with a letter, number, or Space.'); return; }
          onShortcutChange?.(shortcut);
          setMessage('Shortcut saved in this browser.');
          setShortcutCapture(false);
        }} />
        <button type="button" onClick={() => setShortcutCapture(false)}>Cancel</button>
      </div> : featureDraft === null ? <>
        {selectionLabels.length > 0 && <div className={styles.selection} aria-label={`${selectionLabels.length} selected canvas objects`}>
          <span>WITH</span>
          {selectionLabels.slice(0, 3).map((label, position) => <span className={styles.selectionItem} key={`${label}:${position}`}>{label}</span>)}
          {selectionLabels.length > 3 && <span className={styles.selectionItem}>+{selectionLabels.length - 3}</span>}
        </div>}
        <input ref={input} aria-label="Search HII commands" placeholder="Ask, find, create, or do something…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeys} disabled={disabled} />
        <div className={styles.results} role="listbox" aria-label="Commands">
          {visible.map((command, position) => <button key={command.label} type="button" role="option" aria-selected={position === index} onMouseEnter={() => setIndex(position)} onClick={() => run(command.run, command.label)}>
            <span>{command.label}{command.id === activeTool && toolCommands.some((tool) => tool.label === command.label) ? ' ✓' : ''}</span><kbd>{command.shortcut}</kbd>
          </button>)}
          {showStartWork && <button type="button" role="option" aria-selected={index === visible.length} onMouseEnter={() => setIndex(visible.length)} onClick={() => { onStartWork?.(workIntent); setExpanded(false); }}>
            <span>Start work: {workIntent}</span><kbd>review first</kbd>
          </button>}
          {!resultCount && <p>No matching command.</p>}
        </div>
        {workUnavailableReason && workIntent && <p className={styles.unavailable} role="status">{workUnavailableReason}</p>}
      </> : <form onSubmit={(event) => { event.preventDefault(); void saveFeature(); }}>
        <label htmlFor="hii-feature-request">Request a feature</label>
        <input id="hii-feature-request" ref={input} value={featureDraft} maxLength={240} placeholder="What should HII do?" onChange={(event) => setFeatureDraft(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setFeatureDraft(null); } }} />
        <div className={styles.formActions}><button type="button" onClick={() => setFeatureDraft(null)}>Back</button><button type="submit" disabled={featureBusy || featureDraft.trim().length < 2}>{featureBusy ? 'Saving…' : 'Save to board'}</button></div>
      </form>}
      {message && <p role="status" className={styles.message}>{message}</p>}
      <small>↑↓ choose · Enter run · Esc close</small>
    </section>}
  </nav>;
}
