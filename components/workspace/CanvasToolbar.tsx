'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Cursor, NoteBlank, Paperclip, PencilSimple, Shapes, Table, TextT } from '@phosphor-icons/react';
import { ControlButton, ControlDivider, ControlIsland } from '@/components/ui/ControlIsland';
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
  onCaptureText?: (text: string) => void;
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
  onRequestFeature, onCaptureText, onStartWork, selectionLabels = [], workUnavailableReason, shortcutLabel = '⌘K', onShortcutChange
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
    if (onRequestFeature) add('Build a HII feature', 'agent update feature build', () => setFeatureDraft(''));
    if (onShortcutChange) add('Set command shortcut', 'keyboard hotkey', () => setShortcutCapture(true));
    return items;
  }, [capabilities.activity, capabilities.export, capabilities.nativeTerminal, capabilities.remote, capabilities.scenes, capabilities.search, onExport, onFitView, onOpenActivity, onOpenParameters, onOpenRemote, onOpenScenes, onOpenSiteViews, onOpenTerminal, onRequestFeature, onSearch, onShortcutChange, onToolChange, onZoomIn, onZoomOut]);
  const visible = commands.filter((command) => `${command.label} ${command.keywords} ${command.shortcut}`.toLowerCase().includes(query.trim().toLowerCase()));
  const workIntent = query.trim();
  const exactCommand = visible.some((command) => command.label.toLowerCase() === workIntent.toLowerCase());
  const showCapture = Boolean(onCaptureText && workIntent && !exactCommand);
  const showStartWork = Boolean(onStartWork && workIntent);
  const commandOffset = Number(showCapture);
  const resultCount = visible.length + commandOffset + Number(showStartWork);
  const run = (action: () => void, label: string) => {
    if (label === 'Build a HII feature' || label === 'Set command shortcut') { action(); setQuery(''); return; }
    action();
    setExpanded(false);
  };
  const onKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, Math.max(0, resultCount - 1))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
    else if (event.key === 'Enter' && showCapture && index === 0) {
      event.preventDefault(); onCaptureText?.(workIntent); setExpanded(false);
    }
    else if (event.key === 'Enter' && visible[index - commandOffset]) { event.preventDefault(); run(visible[index - commandOffset].run, visible[index - commandOffset].label); }
    else if (event.key === 'Enter' && showStartWork && index === commandOffset + visible.length) { event.preventDefault(); onStartWork?.(workIntent); setExpanded(false); }
  };
  const saveFeature = async () => {
    const title = featureDraft?.trim() || '';
    if (!onRequestFeature || title.length < 8 || featureBusy) return;
    setFeatureBusy(true);
    setMessage('');
    try {
      setMessage(await onRequestFeature(title));
      setFeatureDraft(null);
      setQuery('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start the feature build.');
    } finally { setFeatureBusy(false); }
  };

  const quickTools: Array<{ id: CanvasTool; label: string; icon: React.ReactNode }> = [
    { id: 'select', label: 'Select', icon: <Cursor size={19} /> },
    { id: 'sticky', label: 'Note', icon: <NoteBlank size={19} /> },
    { id: 'text', label: 'Text', icon: <TextT size={19} /> },
    { id: 'shape', label: 'Shape', icon: <Shapes size={19} /> },
    { id: 'table', label: 'Table', icon: <Table size={19} /> },
    { id: 'draw', label: 'Draw', icon: <PencilSimple size={19} /> },
    { id: 'media', label: 'Import', icon: <Paperclip size={19} /> }
  ];

  return <nav className={styles.shell} data-workspace-ui aria-label="Canvas tools" onPointerDown={(event) => event.stopPropagation()}>
    <ControlIsland className={styles.toolbar}>
      <ControlButton className={styles.trigger} label="Open HII companion" aria-expanded={expanded} aria-controls="hii-information-terminal" onClick={() => setExpanded(!expanded)}>
        <span>hii</span><kbd aria-hidden="true">{shortcutLabel}</kbd>
      </ControlButton>
      <ControlDivider />
      {quickTools.map((tool) => <ControlButton
        key={tool.id}
        className={styles.tool}
        label={tool.label}
        aria-pressed={activeTool === tool.id}
        onClick={() => onToolChange(tool.id)}
      >{tool.icon}</ControlButton>)}
    </ControlIsland>
    {expanded && <section id="hii-information-terminal" className={styles.palette} aria-label="HII local companion">
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
        <input ref={input} aria-label="Save to HII or search commands" placeholder="Paste a chat, save a note, or find a command…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeys} disabled={disabled} />
        <div className={styles.results} role="listbox" aria-label="Commands">
          {showCapture && <button type="button" role="option" aria-selected={index === 0} onMouseEnter={() => setIndex(0)} onClick={() => { onCaptureText?.(workIntent); setExpanded(false); }}>
            <span>Save to HII</span><kbd>local</kbd>
          </button>}
          {visible.map((command, position) => <button key={command.label} type="button" role="option" aria-selected={position + commandOffset === index} onMouseEnter={() => setIndex(position + commandOffset)} onClick={() => run(command.run, command.label)}>
            <span>{command.label}{command.id === activeTool && toolCommands.some((tool) => tool.label === command.label) ? ' ✓' : ''}</span><kbd>{command.shortcut}</kbd>
          </button>)}
          {showStartWork && <button type="button" role="option" aria-selected={index === commandOffset + visible.length} onMouseEnter={() => setIndex(commandOffset + visible.length)} onClick={() => { onStartWork?.(workIntent); setExpanded(false); }}>
            <span>Use as a task</span><kbd>review first</kbd>
          </button>}
          {!resultCount && <p>No matching command.</p>}
        </div>
        {workUnavailableReason && workIntent && <p className={styles.unavailable} role="status">{workUnavailableReason}</p>}
      </> : <form onSubmit={(event) => { event.preventDefault(); void saveFeature(); }}>
        <label htmlFor="hii-feature-request">Build a HII feature</label>
        <input id="hii-feature-request" ref={input} value={featureDraft} maxLength={240} placeholder="What should HII do?" onChange={(event) => setFeatureDraft(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setFeatureDraft(null); } }} />
        <div className={styles.formActions}><button type="button" onClick={() => setFeatureDraft(null)}>Back</button><button type="submit" disabled={featureBusy || featureDraft.trim().length < 8}>{featureBusy ? 'Starting…' : 'Start agent'}</button></div>
      </form>}
      {message && <p role="status" className={styles.message}>{message}</p>}
      <small>Local companion · context is shared only through HII access</small>
    </section>}
    <ControlIsland compact className={styles.zoom} aria-label="Canvas zoom">
      <ControlButton compact label="Zoom out" onClick={onZoomOut}>−</ControlButton>
      <ControlButton compact label="Fit canvas" className={styles.fitButton} onClick={onFitView}>Fit</ControlButton>
      <ControlButton compact label="Zoom in" onClick={onZoomIn}>+</ControlButton>
    </ControlIsland>
  </nav>;
}
