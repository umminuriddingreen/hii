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

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function NativeDevBrowser({ nodeId, initialUrl, onUrl, onAgent, onCapture, onOpenObject }: Props) {
  const initial = browserNavigationTarget(initialUrl || '') || 'https://developer.mozilla.org/';
  const [url, setUrl] = useState(initial);
  const [draftUrl, setDraftUrl] = useState(initial);
  const [history, setHistory] = useState([initial]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'captured' | 'error'>('loading');
  const [request, setRequest] = useState('');
  const [device, setDevice] = useState<'responsive' | 'desktop' | 'mobile'>('responsive');
  const [showAgent, setShowAgent] = useState(false);
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

  const commitUrl = useCallback((next: string, pushHistory = true) => {
    setUrl(next);
    setDraftUrl(next);
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
        <form onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
          <span aria-hidden="true">⌁</span>
          <input value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} aria-label="URL or search" spellCheck={false} />
        </form>
        <button type="button" title="View size" onClick={cycleDevice}>{device === 'responsive' ? '↔' : device === 'desktop' ? '▭' : '▯'}</button>
        <button type="button" title="Ask HII about this page" onClick={() => setShowAgent((current) => !current)}>✦</button>
        {onOpenObject && <button type="button" title="Duplicate page as canvas object" onClick={() => onOpenObject(url)}>＋</button>}
        <button type="button" className="hii-browser-capture" title="Capture source" onClick={() => void capture()}>{status === 'captured' ? '✓' : '↓'}</button>
      </nav>
      <section className="hii-browser-workarea">
        <div ref={viewport} className="hii-browser-viewport">
          {!isTauri() && <iframe key={`${url}:${reloadKey}`} src={normalizedBrowserUrl(url) || undefined} title="HII interactive browser" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
          {status === 'loading' && <span className="hii-browser-loading">Opening {targetKind === 'local-service' ? 'local service' : 'website'}…</span>}
          {status === 'error' && <span className="hii-browser-loading">This page refused the embedded view. Open it in its own window or check the local service.</span>}
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
    </article>
  );
}
