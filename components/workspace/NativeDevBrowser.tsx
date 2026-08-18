'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { captureInformation, type InformationCaptureResult } from '@/lib/client/hii-bridge';

type Props = {
  nodeId: string;
  initialUrl?: string;
  onUrl: (url: string) => void;
  onAgent: (request: string) => void;
  onCapture: (result: InformationCaptureResult) => void;
};

function normalizedUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 'https://developer.mozilla.org';
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function NativeDevBrowser({ nodeId, initialUrl, onUrl, onAgent, onCapture }: Props) {
  const [url, setUrl] = useState(initialUrl || 'https://developer.mozilla.org');
  const [status, setStatus] = useState<'loading' | 'ready' | 'captured' | 'error'>('loading');
  const [request, setRequest] = useState('');
  const [device, setDevice] = useState<'responsive' | 'mobile'>('responsive');
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
        url: normalizedUrl(url) || 'https://developer.mozilla.org',
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

  const navigate = async (nextValue = url) => {
    const next = normalizedUrl(nextValue);
    if (!next) { setStatus('error'); return; }
    setUrl(next);
    onUrl(next);
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
    if (!isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('browser_action', { label, action: kind });
  };

  const capture = async () => {
    setStatus('loading');
    try {
      const result = await captureInformation(url);
      onCapture(result);
      setStatus('captured');
    } catch { setStatus('error'); }
  };

  return (
    <article className="hii-dev-browser" data-device={device}>
      <header className="hii-browser-tabs">
        <div><i aria-hidden="true" /><strong>{new URL(normalizedUrl(url) || 'https://developer.mozilla.org').hostname}</strong><small>native</small></div>
        <button type="button" onClick={() => setDevice(device === 'responsive' ? 'mobile' : 'responsive')}>{device === 'responsive' ? 'Responsive' : '390 px'}</button>
      </header>
      <nav className="hii-browser-nav" aria-label="Browser controls">
        <button type="button" title="Back" onClick={() => void action('back')}>←</button>
        <button type="button" title="Forward" onClick={() => void action('forward')}>→</button>
        <button type="button" title="Reload" onClick={() => void action('reload')}>↻</button>
        <form onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
          <span aria-hidden="true">⌁</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="URL" spellCheck={false} />
        </form>
        <button type="button" className="hii-browser-capture" onClick={() => void capture()}>{status === 'captured' ? 'Captured' : 'Capture'}</button>
      </nav>
      <section className="hii-browser-workarea">
        <div ref={viewport} className="hii-browser-viewport">
          {!isTauri() && <iframe src={normalizedUrl(url) || undefined} title="HII development browser preview" sandbox="allow-forms allow-scripts allow-same-origin" />}
          {status === 'loading' && <span className="hii-browser-loading">Loading native view…</span>}
          {status === 'error' && <span className="hii-browser-loading">This page could not be opened.</span>}
        </div>
        <aside className="hii-browser-agent">
          <header><span>Agent lens</span><small>page context</small></header>
          <p>Give HII the current URL and a bounded instruction. Reading is allowed; changes still follow the active mode and approval boundary.</p>
          <form onSubmit={(event) => { event.preventDefault(); if (request.trim()) { onAgent(request.trim()); setRequest(''); } }}>
            <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Explain this codebase, compare docs, or turn findings into an artifact…" />
            <button type="submit" disabled={!request.trim()}>Ask HII <span>⌘ ↵</span></button>
          </form>
          <dl>
            <div><dt>Context</dt><dd>current page</dd></div>
            <div><dt>Authority</dt><dd>read first</dd></div>
            <div><dt>Proof</dt><dd>{status === 'captured' ? 'source saved' : 'on capture'}</dd></div>
          </dl>
        </aside>
      </section>
    </article>
  );
}
