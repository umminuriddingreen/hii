'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowLeft, ArrowRight, Check, DownloadSimple, DotsThree, MagnifyingGlass } from '@phosphor-icons/react';
import { captureInformation, type InformationCaptureResult } from '@/lib/client/hii-bridge';
import { browserNavigationTarget, browserTargetKind, normalizedBrowserUrl } from '@/lib/workspace/browser-target';

type Props = {
  nodeId: string;
  initialUrl?: string;
  onUrl: (url: string) => void;
  onCapture: (result: InformationCaptureResult) => void;
  onOpenObject?: (url: string) => void;
};

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

export function NativeDevBrowser({ nodeId, initialUrl, onUrl, onCapture, onOpenObject }: Props) {
  const initial = browserNavigationTarget(initialUrl || '') || 'https://developer.mozilla.org/';
  const [url, setUrl] = useState(initial);
  const [draftUrl, setDraftUrl] = useState(searchQuery(initial) || initial);
  const [history, setHistory] = useState([initial]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'captured' | 'error'>('loading');
  const [device, setDevice] = useState<'responsive' | 'desktop' | 'mobile'>('responsive');
  const [showMore, setShowMore] = useState(false);
  const [omniboxOpen, setOmniboxOpen] = useState(false);
  const [omniboxIndex, setOmniboxIndex] = useState(0);
  const viewport = useRef<HTMLDivElement | null>(null);
  const webview = useRef<import('@tauri-apps/api/webview').Webview | null>(null);
  const label = `hii-browser-${nodeId.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const omniboxId = `${label}-options`;

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
  const omniboxOptions = useMemo(() => {
    if (!omniboxOpen) return [];
    const input = draftUrl.trim();
    const target = browserNavigationTarget(input);
    if (!target) return [];
    const isAddress = normalizedBrowserUrl(input) !== null;
    const options = [{ target, label: isAddress ? `Open ${input}` : `Search the web for ${input}`, kind: isAddress ? 'address' : 'search' }];
    const seen = new Set([target]);
    for (const entry of [...history].reverse()) {
      if (seen.has(entry) || !entry.toLowerCase().includes(input.toLowerCase())) continue;
      seen.add(entry);
      options.push({ target: entry, label: searchQuery(entry) || entry, kind: 'recent' });
      if (options.length === 5) break;
    }
    return options;
  }, [draftUrl, history, omniboxOpen]);

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
    setOmniboxOpen(false);
    setShowMore(false);
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

  const capture = async () => {
    setStatus('loading');
    try {
      const result = await captureInformation(url);
      onCapture(result);
      setStatus('captured');
    } catch { setStatus('error'); }
  };

  return (
    <article className="hii-dev-browser" data-device={device} data-target={targetKind}>
      <nav className="hii-browser-nav" aria-label="Browser controls">
        <div className="hii-browser-nav-main">
          <button type="button" title="Back" aria-label="Back" disabled={!isTauri() && historyIndex === 0} onClick={() => void action('back')}><ArrowLeft size={16} /></button>
          <button type="button" title="Forward" aria-label="Forward" disabled={!isTauri() && historyIndex >= history.length - 1} onClick={() => void action('forward')}><ArrowRight size={16} /></button>
          <button type="button" title="Reload" aria-label="Reload" onClick={() => void action('reload')}><ArrowClockwise size={16} /></button>
          <form className="hii-browser-address" onSubmit={(event) => { event.preventDefault(); void navigate(omniboxOpen ? omniboxOptions[omniboxIndex]?.target || draftUrl : draftUrl); }}>
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input value={draftUrl} onChange={(event) => { setDraftUrl(event.target.value); setOmniboxOpen(true); setOmniboxIndex(0); }} onFocus={(event) => { event.target.select(); setOmniboxOpen(true); setShowMore(false); }} onBlur={() => setOmniboxOpen(false)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && omniboxOptions.length) { event.preventDefault(); setOmniboxIndex((current) => (current + 1) % omniboxOptions.length); }
              if (event.key === 'ArrowUp' && omniboxOptions.length) { event.preventDefault(); setOmniboxIndex((current) => (current - 1 + omniboxOptions.length) % omniboxOptions.length); }
              if (event.key === 'Escape') { setOmniboxOpen(false); event.currentTarget.blur(); }
            }} role="combobox" aria-autocomplete="list" aria-controls={omniboxId} aria-expanded={omniboxOpen && omniboxOptions.length > 0} aria-activedescendant={omniboxOpen && omniboxOptions.length ? `${omniboxId}-${omniboxIndex}` : undefined} aria-label="Search or open another page" placeholder="Search or enter a URL" spellCheck={false} />
          </form>
          <button type="button" className="hii-browser-capture" title="Capture source" aria-label="Capture source" onClick={() => void capture()}>{status === 'captured' ? <Check size={17} /> : <DownloadSimple size={17} />}</button>
          <button type="button" title="More browser actions" aria-label="More browser actions" aria-expanded={showMore} onClick={() => { setShowMore((current) => !current); setOmniboxOpen(false); }}><DotsThree size={19} /></button>
        </div>
        {omniboxOpen && omniboxOptions.length > 0 && <div className="hii-browser-omnibox-options" id={omniboxId} role="listbox" aria-label="Browser suggestions">
          {omniboxOptions.map((option, index) => <button type="button" role="option" id={`${omniboxId}-${index}`} aria-selected={index === omniboxIndex} key={option.target} onMouseDown={(event) => event.preventDefault()} onClick={() => void navigate(option.target)}><span>{option.kind}</span><strong>{option.label}</strong></button>)}
        </div>}
        {showMore && <div className="hii-browser-more">
          {onOpenObject && <button type="button" onClick={() => { onOpenObject(url); setShowMore(false); }}>Open as object</button>}
          <label>View size <select value={device} onChange={(event) => setDevice(event.target.value as typeof device)}><option value="responsive">Fit</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select></label>
        </div>}
      </nav>
      <section className="hii-browser-workarea">
        <div ref={viewport} className="hii-browser-viewport">
          {!isTauri() && activeSearchQuery && <div className="hii-browser-results" aria-label={`Search request for ${activeSearchQuery}`}>
            <header><span>Local search</span><strong>{activeSearchQuery}</strong></header>
            <p className="hii-browser-results-empty">Web search runs through your local HII runtime in the desktop app or CLI.</p>
          </div>}
          {!isTauri() && !activeSearchQuery && <iframe key={`${url}:${reloadKey}`} src={normalizedBrowserUrl(url) || undefined} title="HII interactive browser" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
          {status === 'loading' && !activeSearchQuery && <span className="hii-browser-loading">{`Opening ${targetKind === 'local-service' ? 'local service' : 'website'}…`}</span>}
          {status === 'error' && <span className="hii-browser-loading">This page refused the embedded view. Open it in its own window or check the local service.</span>}
        </div>
      </section>
    </article>
  );
}
