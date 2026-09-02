'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureInformation, type InformationCaptureResult } from '@/lib/client/hii-bridge';
import { browserNavigationTarget, browserTargetKind, normalizedBrowserUrl } from '@/lib/workspace/browser-target';

type Props = {
  nodeId: string;
  initialUrl?: string;
  onUrl: (url: string) => void;
  onAgent: (request: string) => void;
  onCapture: (result: InformationCaptureResult) => void;
  onOpenObject?: (url: string) => void;
};

type WebSearchResult = { title: string; url: string; description: string };

function searchQuery(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'google.com' || parsed.hostname === 'www.google.com') return parsed.searchParams.get('q')?.trim() || '';
  } catch { /* Invalid values are handled by browserNavigationTarget. */ }
  return '';
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function NativeDevBrowser({ nodeId, initialUrl, onUrl, onAgent, onCapture, onOpenObject }: Props) {
  const initial = browserNavigationTarget(initialUrl || '') || 'https://developer.mozilla.org/';
  const [url, setUrl] = useState(initial);
  const [draftUrl, setDraftUrl] = useState(searchQuery(initial) || initial);
  const [history, setHistory] = useState([initial]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'captured' | 'error'>('loading');
  const [request, setRequest] = useState('');
  const [device, setDevice] = useState<'responsive' | 'desktop' | 'mobile'>('responsive');
  const [showAgent, setShowAgent] = useState(false);
  const [searchResults, setSearchResults] = useState<WebSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const viewport = useRef<HTMLDivElement | null>(null);
  const webview = useRef<import('@tauri-apps/api/webview').Webview | null>(null);
  const label = `hii-browser-${nodeId.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  const syncBounds = useCallback(async () => {
    if (!webview.current || !viewport.current) return;
    const rect = viewport.current.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
    await Promise.all([
      webview.current.setPosition(new LogicalPosition(rect.left, rect.top)),
      webview.current.setSize(new LogicalSize(rect.width, rect.height))
    ]);
  }, []);

  useEffect(() => {
    if (!isTauri() || !viewport.current) { setStatus('ready'); return; }
    let disposed = false;
    let timer = 0;
    void (async () => {
      const [{ Webview }, { getCurrentWindow }] = await Promise.all([
        import('@tauri-apps/api/webview'),
        import('@tauri-apps/api/window')
      ]);
      const existing = await Webview.getByLabel(label);
      if (disposed) return;
      const rect = viewport.current!.getBoundingClientRect();
      const next = existing || new Webview(getCurrentWindow(), label, {
        url: normalizedBrowserUrl(url) || 'https://developer.mozilla.org',
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
      webview.current = next;
      if (existing) await existing.show();
      else {
        await next.once('tauri://created', () => setStatus('ready'));
        await next.once('tauri://error', () => setStatus('error'));
      }
      timer = window.setInterval(() => void syncBounds(), 120);
    })().catch(() => setStatus('error'));
    return () => {
      disposed = true;
      window.clearInterval(timer);
      const current = webview.current;
      webview.current = null;
      if (current) void current.close();
    };
  // The webview belongs to this durable node for its full mounted lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, syncBounds]);

  const targetKind = useMemo(() => browserTargetKind(url), [url]);
  const activeSearchQuery = useMemo(() => searchQuery(url), [url]);
  const locationLabel = !isTauri() && activeSearchQuery ? `Search · ${activeSearchQuery}` : url;

  useEffect(() => {
    if (isTauri() || !activeSearchQuery) { setSearchResults(null); setSearchError(''); return; }
    const controller = new AbortController();
    setSearchResults(null);
    setSearchError('');
    setStatus('loading');
    void fetch(`/api/search?q=${encodeURIComponent(activeSearchQuery)}`, { signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as { results?: WebSearchResult[]; error?: string };
        if (!response.ok) throw new Error(value.error || `Search failed (${response.status})`);
        setSearchResults(value.results || []);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSearchError(error instanceof Error ? error.message : 'Search failed');
        setStatus('error');
      });
    return () => controller.abort();
  }, [activeSearchQuery]);

  const commitUrl = useCallback((next: string, pushHistory = true) => {
    setUrl(next);
    setDraftUrl(searchQuery(next) || next);
    if (pushHistory) {
      setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
      setHistoryIndex((current) => current + 1);
    }
    onUrl(next);
  }, [historyIndex, onUrl]);

  const navigate = async (nextValue = draftUrl) => {
    const next = browserNavigationTarget(nextValue);
    if (!next) { setStatus('error'); return; }
    commitUrl(next);
    setStatus('loading');
    try {
      if (isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('browser_navigate', { label, url: next });
      }
      setStatus('ready');
    } catch { setStatus('error'); }
  };

  const action = async (kind: 'back' | 'forward' | 'reload') => {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('browser_action', { label, action: kind });
      return;
    }
    if (kind === 'reload') {
      setStatus('loading');
      setReloadKey((current) => current + 1);
      return;
    }
    const nextIndex = kind === 'back' ? historyIndex - 1 : historyIndex + 1;
    const next = history[nextIndex];
    if (!next) return;
    setHistoryIndex(nextIndex);
    commitUrl(next, false);
    setStatus('loading');
  };

  const cycleDevice = () => setDevice((current) => current === 'responsive' ? 'desktop' : current === 'desktop' ? 'mobile' : 'responsive');

  const capture = async () => {
    setStatus('loading');
    try {
      const result = await captureInformation(url);
      onCapture(result);
      setStatus('captured');
    } catch { setStatus('error'); }
  };

  return (
    <article className="hii-dev-browser" data-device={device} data-agent={showAgent || undefined} data-target={targetKind}>
      <nav className="hii-browser-nav" aria-label="Browser controls">
        <button type="button" title="Back" disabled={!isTauri() && historyIndex === 0} onClick={() => void action('back')}>←</button>
        <button type="button" title="Forward" disabled={!isTauri() && historyIndex >= history.length - 1} onClick={() => void action('forward')}>→</button>
        <button type="button" title="Reload" onClick={() => void action('reload')}>↻</button>
        <span className="hii-browser-location" title={url}>{locationLabel}</span>
        <button type="button" title="View size" onClick={cycleDevice}>{device === 'responsive' ? '↔' : device === 'desktop' ? '▭' : '▯'}</button>
        <button type="button" title="Ask HII about this page" onClick={() => setShowAgent((current) => !current)}>✦</button>
        {onOpenObject && <button type="button" title="Duplicate page as canvas object" onClick={() => onOpenObject(url)}>＋</button>}
        <button type="button" className="hii-browser-capture" title="Capture source" onClick={() => void capture()}>{status === 'captured' ? '✓' : '↓'}</button>
      </nav>
      <section className="hii-browser-workarea">
        <div ref={viewport} className="hii-browser-viewport">
          {!isTauri() && activeSearchQuery && searchResults && <div className="hii-browser-results" aria-label={`Search results for ${activeSearchQuery}`}>
            <header><span>Web results</span><strong>{activeSearchQuery}</strong></header>
            {searchResults.map((result) => <a key={result.url} href={result.url} onClick={(event) => { event.preventDefault(); void navigate(result.url); }}>
              <small>{new URL(result.url).hostname.replace(/^www\./, '')}</small>
              <h3>{result.title}</h3>
              {result.description && <p>{result.description}</p>}
            </a>)}
            {!searchResults.length && <p className="hii-browser-results-empty">No results found.</p>}
          </div>}
          {!isTauri() && !activeSearchQuery && <iframe key={`${url}:${reloadKey}`} src={normalizedBrowserUrl(url) || undefined} title="HII interactive browser" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
          {status === 'loading' && <span className="hii-browser-loading">{activeSearchQuery ? `Searching for ${activeSearchQuery}…` : `Opening ${targetKind === 'local-service' ? 'local service' : 'website'}…`}</span>}
          {status === 'error' && <span className="hii-browser-loading">{searchError || 'This page refused the embedded view. Open it in its own window or check the local service.'}</span>}
        </div>
        {showAgent && <aside className="hii-browser-agent">
          <header><span>Agent lens</span><small>page context</small></header>
          <p>Give HII the current URL and a bounded instruction. Reading is allowed; changes still follow the active mode and approval boundary.</p>
          <form onSubmit={(event) => { event.preventDefault(); if (request.trim()) { onAgent(request.trim()); setRequest(''); } }}>
            <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Explain this codebase, compare docs, or turn findings into an artifact…" />
            <button type="submit" disabled={!request.trim()}>Ask HII <span>⌘ ↵</span></button>
          </form>
          <dl>
            <div><dt>Context</dt><dd>current page</dd></div>
            <div><dt>Target</dt><dd>{targetKind === 'local-service' ? 'localhost' : 'public web'}</dd></div>
            <div><dt>View</dt><dd>{device}</dd></div>
            <div><dt>Authority</dt><dd>read first</dd></div>
            <div><dt>Proof</dt><dd>{status === 'captured' ? 'source saved' : 'on capture'}</dd></div>
          </dl>
        </aside>}
      </section>
      <form className="hii-browser-hover-search" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <span aria-hidden="true">⌕</span>
        <input
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
          aria-label="Search or open another page"
          placeholder="Search or enter a URL"
          spellCheck={false}
        />
      </form>
    </article>
  );
}
