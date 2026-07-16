'use client';

import { Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

type NoteSummary = {
  id: string;
  title: string;
  path: string;
  folder: string;
  pinned: boolean;
  dailyDate: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  excerpt: string;
  tags: string[];
  outgoingCount: number;
  backlinkCount: number;
};

type Note = Omit<NoteSummary, 'excerpt' | 'tags' | 'outgoingCount' | 'backlinkCount'> & { content: string };
type Link = { sourceNoteId: string; sourceTitle: string; targetTitle: string; targetNoteId: string | null; targetNoteTitle: string | null };
type Version = { id: string; version: number; title: string; path: string; createdAt: string; source: string };
type OutlineItem = { level: number; text: string; line: number };
type NoteDetail = { note: Note; tags: string[]; outgoing: Link[]; backlinks: Link[]; versions: Version[]; outline: OutlineItem[] };
type WorkspaceState = {
  dbPath: string;
  notes: NoteSummary[];
  folders: Array<{ folder: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  trashCount: number;
  events: Array<{ id: string; type: string; noteId: string | null; actor: string; summary: string; createdAt: string }>;
  stats: { notes: number; folders: number; tags: number; links: number; words: number };
};
type GraphState = {
  nodes: Array<{ id: string; title: string; folder: string; pinned: number; updatedAt: string; degree: number }>;
  edges: Array<{ source: string; target: string; targetTitle: string }>;
  unresolved: Array<{ source: string; targetTitle: string }>;
};
type ViewMode = 'write' | 'split' | 'read' | 'graph';

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function wordCount(value: string) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function inlineMarkdown(text: string, onLink: (title: string) => void): ReactNode[] {
  const parts = text.split(/(\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('[[') && part.endsWith(']]')) {
      const raw = part.slice(2, -2);
      const [target, alias] = raw.split('|');
      const title = target.split('#')[0].trim();
      return <button key={`${part}-${index}`} type="button" className="hii-wikilink" onClick={() => onLink(title)}>{alias?.trim() || raw}</button>;
    }
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${part}-${index}`} className="hii-inline-code">{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
  });
}

function MarkdownPreview({ content, onLink }: { content: string; onLink: (title: string) => void }) {
  const lines = content.split('\n');
  const output: ReactNode[] = [];
  let code: string[] | null = null;
  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (code) {
        output.push(<pre key={`code-${index}`} className="hii-code-block"><code>{code.join('\n')}</code></pre>);
        code = null;
      } else code = [];
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      output.push(<Tag key={index} className={`hii-md-heading hii-md-h${heading[1].length}`}>{inlineMarkdown(heading[2], onLink)}</Tag>);
      return;
    }
    const task = line.match(/^\s*-\s+\[([ xX])\]\s*(.*)$/);
    if (task) {
      output.push(<label key={index} className="hii-md-task"><input type="checkbox" checked={task[1].toLowerCase() === 'x'} readOnly /> <span>{inlineMarkdown(task[2], onLink)}</span></label>);
      return;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      output.push(<div key={index} className="hii-md-bullet"><span>—</span><p>{inlineMarkdown(bullet[1], onLink)}</p></div>);
      return;
    }
    if (line.startsWith('> ')) {
      output.push(<blockquote key={index}>{inlineMarkdown(line.slice(2), onLink)}</blockquote>);
      return;
    }
    if (/^---+$/.test(line.trim())) {
      output.push(<hr key={index} />);
      return;
    }
    if (!line.trim()) output.push(<div key={index} className="hii-md-space" />);
    else output.push(<p key={index}>{inlineMarkdown(line, onLink)}</p>);
  });
  const trailingCode = code as string[] | null;
  if (trailingCode) output.push(<pre key="code-final" className="hii-code-block"><code>{trailingCode.join('\n')}</code></pre>);
  return <article className="hii-markdown-preview">{output}</article>;
}

function KnowledgeGraph({ graph, selectedId, onSelect }: { graph: GraphState; selectedId?: string; onSelect: (id: string) => void }) {
  const width = 900;
  const height = 620;
  const centerX = width / 2;
  const centerY = height / 2;
  const positions = new Map(graph.nodes.map((node, index) => {
    const ring = index < 1 ? 0 : index < 9 ? 1 : 2;
    const ringItems = graph.nodes.filter((_item, itemIndex) => (itemIndex < 1 ? 0 : itemIndex < 9 ? 1 : 2) === ring).length;
    const ringIndex = graph.nodes.slice(0, index).filter((_item, itemIndex) => (itemIndex < 1 ? 0 : itemIndex < 9 ? 1 : 2) === ring).length;
    const radius = ring === 0 ? 0 : ring === 1 ? 190 : 285;
    const angle = ring === 0 ? 0 : (ringIndex / Math.max(ringItems, 1)) * Math.PI * 2 - Math.PI / 2;
    return [node.id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius }] as const;
  }));
  return (
    <div className="hii-graph-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Knowledge graph">
        <g className="hii-graph-grid">
          {Array.from({ length: 18 }, (_, index) => <line key={`v-${index}`} x1={index * 50} x2={index * 50} y1="0" y2={height} />)}
          {Array.from({ length: 13 }, (_, index) => <line key={`h-${index}`} x1="0" x2={width} y1={index * 50} y2={index * 50} />)}
        </g>
        <g className="hii-graph-edges">
          {graph.edges.map((edge, index) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            return source && target ? <line key={`${edge.source}-${edge.target}-${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} /> : null;
          })}
        </g>
        {graph.nodes.map((node) => {
          const position = positions.get(node.id)!;
          const selected = node.id === selectedId;
          const radius = Math.min(11 + Number(node.degree) * 1.6, 24);
          return (
            <g key={node.id} className={`hii-graph-node ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(node.id)} role="button" tabIndex={0}>
              <circle cx={position.x} cy={position.y} r={radius} />
              <text x={position.x} y={position.y + radius + 18} textAnchor="middle">{node.title.slice(0, 24)}</text>
            </g>
          );
        })}
      </svg>
      {graph.nodes.length === 0 && <div className="hii-graph-empty">Create two notes and connect them with <code>[[wikilinks]]</code>.</div>}
    </div>
  );
}

export function KnowledgeWorkspace({ initialWorkspace, initialNote }: { initialWorkspace: WorkspaceState; initialNote: NoteDetail | null }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [detail, setDetail] = useState<NoteDetail | null>(initialNote);
  const [draft, setDraft] = useState(initialNote?.note ?? null);
  const [view, setView] = useState<ViewMode>('split');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; title: string; path: string; excerpt: string }>>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphState>({ nodes: [], edges: [], unresolved: [] });
  const [trash, setTrash] = useState<NoteSummary[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [isPending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<Note | null>(initialNote?.note ?? null);
  const matchRef = useRef<string | null>(initialNote?.note.updatedAt ?? null);

  const visibleNotes = useMemo<Array<{ id: string; title: string; path: string; excerpt: string; pinned?: boolean; updatedAt?: string; backlinkCount?: number }>>(() => {
    if (query.trim()) return searchResults;
    return workspace.notes.filter((note) => (!selectedFolder || note.folder === selectedFolder) && (!selectedTag || note.tags.includes(selectedTag)));
  }, [query, searchResults, selectedFolder, selectedTag, workspace.notes]);

  const refreshWorkspace = useCallback(async () => {
    const response = await fetch('/api/knowledge', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not refresh knowledge workspace.');
    setWorkspace(data);
  }, []);

  const openNote = useCallback(async (id: string) => {
    if (!id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setMessage('');
    const response = await fetch(`/api/knowledge?mode=note&id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || 'Could not open note.');
      return;
    }
    setDetail(data);
    setDraft(data.note);
    draftRef.current = data.note;
    matchRef.current = data.note.updatedAt;
    setSaveState('idle');
    setPaletteOpen(false);
  }, []);

  const loadGraph = useCallback(async () => {
    const response = await fetch('/api/knowledge?mode=graph', { cache: 'no-store' });
    const data = await response.json();
    if (response.ok) setGraph(data);
  }, []);

  useEffect(() => {
    if (view === 'graph') void loadGraph();
  }, [loadGraph, view, workspace.notes.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void createNote();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        if (draftRef.current) void saveNote(draftRef.current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/knowledge?mode=search&q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const data = await response.json();
      if (response.ok) setSearchResults(data.results || []);
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  async function mutate(action: string, body: Record<string, unknown> = {}) {
    const response = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...body })
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || 'Knowledge action failed.') as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function createNote(title = 'Untitled', folder = selectedFolder || '') {
    try {
      const data = await mutate('create', { title, folder, content: `# ${title}\n\n` });
      await refreshWorkspace();
      await openNote(data.note.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create note.');
    }
  }

  async function openDaily() {
    try {
      const data = await mutate('daily', { date: new Date().toISOString().slice(0, 10) });
      await refreshWorkspace();
      await openNote(data.note.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open daily note.');
    }
  }

  async function saveNote(note: Note) {
    setSaveState('saving');
    try {
      const data = await mutate('save', {
        id: note.id,
        title: note.title,
        folder: note.folder,
        content: note.content,
        pinned: note.pinned,
        ifMatch: matchRef.current
      });
      setDetail(data);
      setDraft(data.note);
      draftRef.current = data.note;
      matchRef.current = data.note.updatedAt;
      setSaveState('saved');
      await refreshWorkspace();
      setTimeout(() => setSaveState((current) => current === 'saved' ? 'idle' : current), 1200);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      setSaveState(status === 409 ? 'conflict' : 'error');
      setMessage(error instanceof Error ? error.message : 'Could not save note.');
    }
  }

  function changeDraft(patch: Partial<Note>) {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    draftRef.current = next;
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNote(next), 850);
  }

  async function followWikiLink(title: string) {
    const existing = workspace.notes.find((note) => note.title.toLowerCase() === title.toLowerCase());
    if (existing) return openNote(existing.id);
    await createNote(title, draft?.folder || '');
  }

  async function trashCurrent() {
    if (!draft) return;
    try {
      await mutate('trash', { id: draft.id });
      setDetail(null);
      setDraft(null);
      draftRef.current = null;
      matchRef.current = null;
      await refreshWorkspace();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not move note to trash.');
    }
  }

  async function loadTrash() {
    const response = await fetch('/api/knowledge?mode=trash', { cache: 'no-store' });
    const data = await response.json();
    if (response.ok) setTrash(data.notes || []);
    setShowTrash(true);
  }

  async function restoreNote(id: string) {
    await mutate('restore', { id });
    await refreshWorkspace();
    await loadTrash();
    await openNote(id);
  }

  async function restoreVersion(version: number) {
    if (!draft || !window.confirm(`Restore version ${version}? The current state remains in history.`)) return;
    try {
      const data = await mutate('restore-version', { id: draft.id, version, ifMatch: matchRef.current });
      setDetail(data);
      setDraft(data.note);
      draftRef.current = data.note;
      matchRef.current = data.note.updatedAt;
      setSaveState('saved');
      await refreshWorkspace();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not restore version.');
    }
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    startTransition(async () => {
      try {
        const payload = await Promise.all(Array.from(files).slice(0, 200).map(async (file) => ({ name: file.name, path: file.webkitRelativePath || file.name, content: await file.text() })));
        const data = await mutate('import', { files: payload });
        await refreshWorkspace();
        if (data.notes?.[0]?.note?.id) await openNote(data.notes[0].note.id);
        setMessage(`Imported ${data.notes?.length || 0} note${data.notes?.length === 1 ? '' : 's'}.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Import failed.');
      }
    });
  }

  const commands = [
    { label: 'New note', hint: '⌘ N', action: () => createNote() },
    { label: 'Open today', hint: 'daily', action: openDaily },
    { label: 'Show graph', hint: 'links', action: () => setView('graph') },
    { label: 'Import Markdown', hint: 'local', action: () => fileInput.current?.click() },
    { label: 'Export workspace', hint: 'JSON', action: () => { window.location.href = '/api/knowledge?mode=export'; } },
    ...workspace.notes.slice(0, 20).map((note) => ({ label: note.title, hint: note.folder || 'root', action: () => openNote(note.id) }))
  ].filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(paletteQuery.toLowerCase()));

  return (
    <main className="hii-knowledge-workspace">
      <aside className="hii-knowledge-sidebar">
        <div className="hii-knowledge-search-wrap">
          <span>⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your knowledge" aria-label="Search notes" />
          <kbd>⌘K</kbd>
        </div>
        <div className="hii-knowledge-actions">
          <button type="button" onClick={() => createNote()}>＋ note</button>
          <button type="button" onClick={openDaily}>◫ today</button>
          <button type="button" onClick={() => fileInput.current?.click()}>⇧ import</button>
          <input ref={fileInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden onChange={(event) => void importFiles(event.target.files)} />
        </div>
        <div className="hii-knowledge-navscroll">
          <section className="hii-knowledge-navsection">
            <h2>Folders <span>{workspace.folders.length}</span></h2>
            <button className={!selectedFolder ? 'is-active' : ''} onClick={() => { setSelectedFolder(null); setSelectedTag(null); }}>⌂ All notes <b>{workspace.notes.length}</b></button>
            {workspace.folders.map((folder) => <button key={folder.folder || 'root'} className={selectedFolder === folder.folder ? 'is-active' : ''} onClick={() => { setSelectedFolder(folder.folder); setSelectedTag(null); }}>⌙ {folder.folder || 'Root'} <b>{folder.count}</b></button>)}
          </section>
          <section className="hii-knowledge-navsection">
            <h2>Tags <span>{workspace.tags.length}</span></h2>
            {workspace.tags.slice(0, 24).map((tag) => <button key={tag.tag} className={selectedTag === tag.tag ? 'is-active' : ''} onClick={() => { setSelectedTag(tag.tag); setSelectedFolder(null); }}># {tag.tag} <b>{tag.count}</b></button>)}
          </section>
          <section className="hii-knowledge-navsection">
            <h2>System</h2>
            <button onClick={() => setView('graph')}>⌬ Graph <b>{workspace.stats.links}</b></button>
            <button onClick={loadTrash}>⌫ Trash <b>{workspace.trashCount}</b></button>
          </section>
        </div>
        <div className="hii-knowledge-db">
          <span><i /> local database</span>
          <code title={workspace.dbPath}>~/.hii/hii.db</code>
        </div>
      </aside>

      <section className="hii-knowledge-index">
        <header>
          <div>
            <span className="hii-knowledge-eyebrow">{query ? 'Search' : selectedTag ? `#${selectedTag}` : selectedFolder || 'All notes'}</span>
            <h1>{query ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}` : `${visibleNotes.length} note${visibleNotes.length === 1 ? '' : 's'}`}</h1>
          </div>
          <button onClick={() => setPaletteOpen(true)} aria-label="Open command palette">⌘</button>
        </header>
        <div className="hii-knowledge-note-list">
          {visibleNotes.map((note) => (
            <button key={note.id} className={draft?.id === note.id ? 'is-active' : ''} onClick={() => openNote(note.id)}>
              <span className="hii-note-title">{note.pinned && <i>◆</i>}{note.title}</span>
              <span className="hii-note-path">{note.path}</span>
              <span className="hii-note-excerpt">{note.excerpt || 'Empty note'}</span>
              <span className="hii-note-meta"><time>{note.updatedAt ? formatTime(note.updatedAt) : 'match'}</time><span>{note.backlinkCount !== undefined ? `${note.backlinkCount}↙` : ''}</span></span>
            </button>
          ))}
          {visibleNotes.length === 0 && <div className="hii-knowledge-empty"><strong>{query ? 'Nothing matched.' : 'The desk is clear.'}</strong><span>{query ? 'Try a different phrase or open the command palette.' : 'Create a note, open today, or import Markdown.'}</span><button onClick={() => createNote()}>Create first note</button></div>}
        </div>
      </section>

      <section className="hii-knowledge-main">
        <div className="hii-knowledge-toolbar">
          <div className="hii-view-switch" role="group" aria-label="Knowledge view">
            {(['write', 'split', 'read', 'graph'] as ViewMode[]).map((mode) => <button key={mode} className={view === mode ? 'is-active' : ''} onClick={() => setView(mode)}>{mode}</button>)}
          </div>
          <div className="hii-save-state" data-state={saveState}><i /> {saveState === 'idle' ? 'local' : saveState}</div>
          {draft && <div className="hii-note-tools"><button onClick={() => changeDraft({ pinned: !draft.pinned })}>{draft.pinned ? '◆ pinned' : '◇ pin'}</button><a href={`/api/knowledge?mode=export-note&id=${draft.id}`}>↓ .md</a><button onClick={trashCurrent}>⌫</button></div>}
        </div>

        {view === 'graph' ? (
          <div className="hii-knowledge-graph-page">
            <div className="hii-graph-heading"><span>Knowledge constellation</span><small>{graph.nodes.length} notes / {graph.edges.length} resolved links / {graph.unresolved.length} open edges</small></div>
            <KnowledgeGraph graph={graph} selectedId={draft?.id} onSelect={(id) => { void openNote(id); setView('split'); }} />
          </div>
        ) : draft ? (
          <div className={`hii-editor-grid is-${view}`}>
            {view !== 'read' && <div className="hii-editor-pane">
              <div className="hii-note-properties">
                <input className="hii-note-title-input" value={draft.title} onChange={(event) => changeDraft({ title: event.target.value })} aria-label="Note title" />
                <div className="hii-note-property-row"><span>folder</span><input value={draft.folder} onChange={(event) => changeDraft({ folder: event.target.value })} placeholder="Root" /><span>{wordCount(draft.content)} words</span></div>
              </div>
              <textarea className="hii-markdown-editor" value={draft.content} onChange={(event) => changeDraft({ content: event.target.value })} spellCheck aria-label="Markdown editor" />
            </div>}
            {view !== 'write' && <div className="hii-preview-pane"><MarkdownPreview content={draft.content} onLink={followWikiLink} /></div>}
            <aside className="hii-knowledge-context">
              <section><h2>Outline <span>{detail?.outline.length || 0}</span></h2>{detail?.outline.map((item) => <button key={`${item.line}-${item.text}`} style={{ paddingLeft: `${(item.level - 1) * 10 + 8}px` }}>{item.text}<b>L{item.line}</b></button>)}{!detail?.outline.length && <p>No headings yet.</p>}</section>
              <section><h2>Backlinks <span>{detail?.backlinks.length || 0}</span></h2>{detail?.backlinks.map((link) => <button key={link.sourceNoteId} onClick={() => openNote(link.sourceNoteId)}>↙ {link.sourceTitle}</button>)}{!detail?.backlinks.length && <p>Link here with <code>[[{draft.title}]]</code>.</p>}</section>
              <section><h2>Outgoing <span>{detail?.outgoing.length || 0}</span></h2>{detail?.outgoing.map((link) => <button key={link.targetTitle} onClick={() => followWikiLink(link.targetTitle)} className={!link.targetNoteId ? 'is-unresolved' : ''}>↗ {link.targetTitle}{!link.targetNoteId && <b>new</b>}</button>)}</section>
              <section><h2>Tags <span>{detail?.tags.length || 0}</span></h2><div className="hii-context-tags">{detail?.tags.map((tag) => <button key={tag} onClick={() => { setSelectedTag(tag); setSelectedFolder(null); }}>#{tag}</button>)}</div></section>
              <section><h2>History <span>{detail?.versions.length || 0}</span></h2>{detail?.versions.slice(0, 8).map((version) => <button key={version.id} onClick={() => restoreVersion(version.version)}>v{version.version}<b>{formatTime(version.createdAt)}</b></button>)}</section>
            </aside>
          </div>
        ) : (
          <div className="hii-knowledge-welcome">
            <span className="hii-knowledge-kicker">Human Information Interface</span>
            <h1>Make thought<br />stay useful.</h1>
            <p>Local Markdown, source-linked context, agent receipts, and a graph that grows from real work—not another blank notes app.</p>
            <div><button onClick={() => createNote('Start here')}>Create a note</button><button onClick={openDaily}>Open today</button></div>
            <code>[[link ideas]] · #shape-context · ⌘K to move</code>
          </div>
        )}
        {message && <div className="hii-knowledge-toast" role="status"><span>{message}</span><button onClick={() => setMessage('')}>×</button></div>}
      </section>

      {showTrash && <div className="hii-knowledge-modal" role="dialog" aria-modal="true" aria-label="Trash"><div className="hii-modal-card"><header><div><span className="hii-knowledge-eyebrow">Recoverable</span><h2>Trash</h2></div><button onClick={() => setShowTrash(false)}>×</button></header>{trash.map((note) => <div key={note.id} className="hii-trash-row"><div><strong>{note.title}</strong><span>{note.path}</span></div><button onClick={() => restoreNote(note.id)}>Restore</button></div>)}{trash.length === 0 && <p className="hii-modal-empty">Trash is empty.</p>}</div></div>}

      {paletteOpen && <div className="hii-command-overlay" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={() => setPaletteOpen(false)}><div className="hii-command-palette" onMouseDown={(event) => event.stopPropagation()}><div className="hii-command-input"><span>⌘</span><input autoFocus value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Type a command or note…" /></div><div className="hii-command-results">{commands.map((command, index) => <button key={`${command.label}-${index}`} onClick={() => { command.action(); setPaletteOpen(false); setPaletteQuery(''); }}><span>{command.label}</span><kbd>{command.hint}</kbd></button>)}</div><footer><span>↑↓ move</span><span>↵ open</span><span>esc close</span></footer></div></div>}
    </main>
  );
}
