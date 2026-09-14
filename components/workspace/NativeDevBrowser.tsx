'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureInformation, type InformationCaptureResult } from '@/lib/client/hii-bridge';
import { browserNavigationTarget, browserTargetKind, localBrowserSearchTarget, normalizedBrowserUrl } from '@/lib/workspace/browser-target';

type Props = {
  nodeId: string;
  initialUrl?: string;
  startEmpty?: boolean;
  docked?: boolean;
  onUrl: (url: string) => void;
  onAgent?: (request: string) => void;
  onCapture?: (result: InformationCaptureResult) => void;
  onOpenObject?: (url: string) => void;
};

function searchQuery(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'google.com' || parsed.hostname === 'www.google.com') return parsed.searchParams.get('q')?.trim() || '';
    if (parsed.hostname === '127.0.0.1' && parsed.port === '8888' && parsed.pathname === '/search') return parsed.searchParams.get('q')?.trim() || '';
  } catch { /* Invalid values are handled by browserNavigationTarget. */ }
  return '';
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function NativeDevBrowser({ nodeId, initialUrl, startEmpty = false, docked = false, onUrl, onAgent, onCapture, onOpenObject }: Props) {
  const initial = startEmpty ? '' : browserNavigationTarget(initialUrl || '') || 'https://developer.mozilla.org/';
  const [url, setUrl] = useState(initial);
  const [draftUrl, setDraftUrl] = useState(searchQuery(initial) || initial);
  const [history, setHistory] = useState([initial]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'captured' | 'error'>('loading');
  const [request, setRequest] = useState('');
  const [device, setDevice] = useState<'responsive' | 'desktop' | 'mobile'>('responsive');
  const [showAgent, setShowAgent] = useState(false);
  const viewport = useRef<HTMLDivElement | null>(null);
  const webview = useRef<import('@tauri-apps/api/webview').Webview | null>(null);
  const lastBounds = useRef('');
  const boundsInFlight = useRef(false);
  const label = `hii-browser-${nodeId.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  const syncBounds = useCallback(async () => {
    if (!webview.current || !viewport.current || boundsInFlight.current) return;
    const rect = viewport.current.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const bounds = [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)).join(':');
    if (bounds === lastBounds.current) return;
    boundsInFlight.current = true;
    try {
      const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
      const current = webview.current;
      if (!current) return;
      await Promise.all([
        current.setPosition(new LogicalPosition(rect.left, rect.top)),
        current.setSize(new LogicalSize(rect.width, rect.height))
      ]);
      lastBounds.current = bounds;
    } finally {
      boundsInFlight.current = false;
    }
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
        url: normalizedBrowserUrl(url) || 'about:blank',
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
      webview.current = next;
      lastBounds.current = existing ? '' : [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)).join(':');
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
      lastBounds.current = '';
      if (current) void current.close();
    };
  // The webview belongs to this durable node for its full mounted lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, syncBounds]);

  const targetKind = useMemo(() => browserTargetKind(url), [url]);
  const activeSearchQuery = useMemo(() => searchQuery(url), [url]);
  const locationLabel = !isTauri() && activeSearchQuery ? `Search · ${activeSearchQuery}` : url;

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
    const next = isTauri() ? localBrowserSearchTarget(nextValue) : browserNavigationTarget(nextValue);
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
    if (!onCapture || !url) return;
    setStatus('loading');
    try {
      const result = await captureInformation(url);
      onCapture(result);
      setStatus('captured');
    } catch { setStatus('error'); }
  };

  return (
    <article className="hii-dev-browser" data-device={device} data-agent={showAgent || undefined} data-target={targetKind} data-docked={docked || undefined}>
      <nav className="hii-browser-nav" aria-label="Browser controls">
        <button type="button" title="Back" disabled={!isTauri() && historyIndex === 0} onClick={() => void action('back')}>←</button>
        <button type="button" title="Forward" disabled={!isTauri() && historyIndex >= history.length - 1} onClick={() => void action('forward')}>→</button>
        <button type="button" title="Reload" onClick={() => void action('reload')}>↻</button>
        {docked ? <form className="hii-browser-dock-address" onSubmit={(event) => { event.preventDefault(); void navigate(); }}><input value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} aria-label="Search or enter a URL" placeholder="Search or enter a URL" spellCheck={false} /></form> : <span className="hii-browser-location" title={url}>{locationLabel}</span>}
        <button type="button" title="View size" onClick={cycleDevice}>{device === 'responsive' ? '↔' : device === 'desktop' ? '▭' : '▯'}</button>
        {onAgent && <button type="button" title="Ask HII about this page" onClick={() => setShowAgent((current) => !current)}>✦</button>}
        {onOpenObject && <button type="button" title="Duplicate page as canvas object" onClick={() => onOpenObject(url)}>＋</button>}
        {onCapture && <button type="button" className="hii-browser-capture" title="Capture source" onClick={() => void capture()}>{status === 'captured' ? '✓' : '↓'}</button>}
      </nav>
      <section className="hii-browser-workarea">
        <div ref={viewport} className="hii-browser-viewport">
          {!isTauri() && activeSearchQuery && <div className="hii-browser-results" aria-label={`Search options for ${activeSearchQuery}`}>
            <header><span>Search the web</span><strong>{activeSearchQuery}</strong></header>
            <p>Search inside HII uses the local search service on a connected computer. This browser-only canvas cannot reach that service.</p>
            <a className="hii-browser-search-external" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open web results for ${activeSearchQuery} in a new tab`}>Open web results in a new tab ↗</a>
          </div>}
          {!url && <div className="hii-browser-empty"><span aria-hidden="true">◎</span><strong>Start browsing</strong><p>Enter a URL or search above.</p></div>}
          {!isTauri() && url && !activeSearchQuery && <iframe key={`${url}:${reloadKey}`} src={normalizedBrowserUrl(url) || undefined} title="HII interactive browser" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
          {status === 'loading' && !activeSearchQuery && <span className="hii-browser-loading">Opening {targetKind === 'local-service' ? 'local service' : 'website'}…</span>}
          {status === 'error' && <span className="hii-browser-loading">This page refused the embedded view. Open it in its own window or check the local service.</span>}
        </div>
        {showAgent && <aside className="hii-browser-agent">
          <header><span>Agent lens</span><small>page context</small></header>
          <p>Give HII the current URL and a bounded instruction. Reading is allowed; changes still follow the active mode and approval boundary.</p>
          <form onSubmit={(event) => { event.preventDefault(); if (request.trim()) { onAgent?.(request.trim()); setRequest(''); } }}>
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
      {!docked && <form className="hii-browser-hover-search" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <span aria-hidden="true">⌕</span>
        <input
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
          aria-label="Search or open another page"
          placeholder="Search or enter a URL"
          spellCheck={false}
        />
      </form>}
    </article>
  );
}
