'use client';

import { invoke, isTauri } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type BrowserNodeProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

type SearchResult = { title: string; url: string; description: string };

type History = {
  entries: string[];
  index: number;
};

type EmbedMode = 'detecting' | 'native' | 'web';

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; url: string }
  | { kind: 'page'; url: string }
  | { kind: 'blocked'; url: string }
  | { kind: 'results'; query: string; results: SearchResult[] }
  | { kind: 'error'; message: string };

function normalizeUrl(input: string): string | null {
  const t = input.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

export default function BrowserNode({ node, onPayload }: BrowserNodeProps) {
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [input, setInput] = useState(String(node.payload.url ?? node.payload.query ?? ''));
  const [history, setHistory] = useState<History>({ entries: [], index: -1 });
  const [frameKey, setFrameKey] = useState(0);
  const [embedMode, setEmbedMode] = useState<EmbedMode>('detecting');
  const [externalState, setExternalState] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle');
  const nativeFrameRef = useRef<HTMLDivElement | null>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const browserLabelRef = useRef(`hii-browser-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`);
  const restoredRef = useRef(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  const navigate = useCallback(async (rawUrl: string, historyMode: 'push' | 'replace' | 'skip' = 'push') => {
    const url = normalizeUrl(rawUrl) ?? rawUrl;
    if (!/^https?:\/\//i.test(url)) {
      setView({ kind: 'error', message: 'enter a web address or search query' });
      return;
    }
    if (historyMode !== 'skip') {
      setHistory((current) => {
        if (historyMode === 'replace' && current.index >= 0) {
          const entries = [...current.entries];
          entries[current.index] = url;
          return { entries, index: current.index };
        }
        if (current.entries[current.index] === url) return current;
        const entries = [...current.entries.slice(0, current.index + 1), url];
        return { entries, index: entries.length - 1 };
      });
    }
    setExternalState('idle');
    setInput(url);
    setView({ kind: 'loading', url });
    onPayloadRef.current({ url, title: (() => { try { return new URL(url).hostname; } catch { return url; } })() });
    const navigateInWeb = async () => {
      const res = await fetch(`/api/browse/check?url=${encodeURIComponent(url)}`);
      const data = (await res.json()) as { frameable?: boolean; finalUrl?: string };
      const finalUrl = data.finalUrl || url;
      if (!data.frameable) {
        setView({ kind: 'blocked', url: finalUrl });
        return;
      }
      setFrameKey((key) => key + 1);
      setView({ kind: 'page', url: finalUrl });
      if (loadTimer.current) clearTimeout(loadTimer.current);
      loadTimer.current = setTimeout(() => {
        setView((current) => (current.kind === 'page' && current.url === finalUrl ? { kind: 'blocked', url: finalUrl } : current));
      }, 10_000);
    };

    try {
      if (embedMode === 'native') {
        await invoke('browser_navigate', { label: browserLabelRef.current, url });
        setView({ kind: 'page', url });
        return;
      }
      await navigateInWeb();
    } catch {
      if (embedMode === 'native') {
        nativeWebviewRef.current?.hide().catch(() => {});
        setEmbedMode('web');
        try {
          await navigateInWeb();
          return;
        } catch {
          // Report the shared fallback failure below.
        }
      }
      setView({ kind: 'error', message: 'embedded browsing failed' });
    }
  }, [embedMode]);

  const search = useCallback(async (query: string) => {
    setView({ kind: 'loading', url: `search: ${query}` });
    onPayloadRef.current({ query, title: `search: ${query}` });
    const directSearch = () => navigate(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = (await res.json()) as { results?: SearchResult[]; error?: string };
      if (!res.ok || !data.results) {
        await directSearch();
        return;
      }
      setView({ kind: 'results', query, results: data.results });
    } catch {
      await directSearch();
    }
  }, [navigate]);

  const submit = useCallback(
    (value: string) => {
      const t = value.trim();
      if (!t) return;
      const url = normalizeUrl(t);
      if (url) navigate(url);
      else search(t);
    },
    [navigate, search]
  );

  useEffect(() => {
    let mounted = true;
    if (!isTauri()) {
      setEmbedMode('web');
      return;
    }

    const activate = (webview: Webview) => {
      if (!mounted) {
        webview.hide().catch(() => {});
        return;
      }
      nativeWebviewRef.current = webview;
      setEmbedMode('native');
    };

    (async () => {
      try {
        const label = browserLabelRef.current;
        const existing = await Webview.getByLabel(label);
        if (existing) {
          await existing.hide();
          activate(existing);
          return;
        }

        const webview = new Webview(getCurrentWindow(), label, {
          url: 'about:blank',
          x: 0,
          y: 0,
          width: 1,
          height: 1
        });
        nativeWebviewRef.current = webview;
        await webview.once('tauri://created', () => {
          webview.hide().catch(() => {});
          activate(webview);
        });
        await webview.once('tauri://error', () => {
          nativeWebviewRef.current = null;
          if (mounted) setEmbedMode('web');
        });
      } catch {
        nativeWebviewRef.current = null;
        if (mounted) setEmbedMode('web');
      }
    })();

    return () => {
      mounted = false;
      nativeWebviewRef.current?.hide().catch(() => {});
    };
  }, []);

  // A native child-webview is an OS surface rather than DOM content. Keep its
  // logical bounds aligned while the spatial canvas pans, zooms, or resizes.
  useEffect(() => {
    if (embedMode !== 'native') return;
    const webview = nativeWebviewRef.current;
    if (!webview) return;

    let frame = 0;
    let active = true;
    let shown = false;
    let lastBounds = '';

    (async () => {
      const window = getCurrentWindow();
      const [inner, outer, scale] = await Promise.all([window.innerSize(), window.outerSize(), window.scaleFactor()]);
      const chromeOffset = (outer.height - inner.height) / scale;

      const sync = () => {
        if (!active) return;
        const element = nativeFrameRef.current;
        const rect = element?.getBoundingClientRect();
        const shouldShow =
          view.kind === 'page' &&
          document.visibilityState === 'visible' &&
          !document.documentElement.hasAttribute('data-hii-omnibar-open') &&
          Boolean(rect && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < inner.width / scale && rect.top < inner.height / scale);

        if (shouldShow && rect) {
          const bounds = [rect.x, rect.y, rect.width, rect.height].map((value) => value.toFixed(1)).join(':');
          if (bounds !== lastBounds) {
            lastBounds = bounds;
            Promise.all([
              webview.setPosition(new LogicalPosition(rect.x, rect.y + chromeOffset)),
              webview.setSize(new LogicalSize(rect.width, rect.height))
            ]).catch(() => {});
          }
          if (!shown) {
            shown = true;
            webview.show().catch(() => {});
          }
        } else if (shown) {
          shown = false;
          webview.hide().catch(() => {});
        }
        frame = requestAnimationFrame(sync);
      };

      sync();
    })().catch(() => {
      if (active) setEmbedMode('web');
    });

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      webview.hide().catch(() => {});
    };
  }, [embedMode, view.kind]);

  // Restore persisted state after the native/web embedding decision resolves.
  useEffect(() => {
    if (embedMode === 'detecting' || restoredRef.current) return;
    restoredRef.current = true;
    const url = node.payload.url;
    const query = node.payload.query;
    if (typeof url === 'string' && url) navigate(url);
    else if (typeof query === 'string' && query) search(query);
  }, [embedMode, navigate, node.payload.query, node.payload.url, search]);

  useEffect(
    () => () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    },
    []
  );

  const iframeLoaded = () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
  };

  const goHistory = (offset: -1 | 1) => {
    const index = history.index + offset;
    const url = history.entries[index];
    if (!url) return;
    setHistory((current) => ({ ...current, index }));
    navigate(url, 'skip');
  };

  const reload = () => {
    if (view.kind !== 'page' && view.kind !== 'blocked') return;
    navigate(view.url, 'replace');
  };

  const goHome = () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
    setView({ kind: 'idle' });
    setInput('');
    setExternalState('idle');
    onPayloadRef.current({ url: '', query: '', title: 'browser' });
  };

  const openExternal = async (url: string) => {
    setExternalState('opening');
    try {
      const response = await fetch('/api/files/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url })
      });
      setExternalState(response.ok ? 'opened' : 'error');
    } catch {
      setExternalState('error');
    }
  };

  const status =
    embedMode === 'detecting'
      ? 'starting embed'
      : view.kind === 'page'
        ? embedMode === 'native'
          ? 'native embedded'
          : 'web embedded'
      : view.kind === 'blocked'
        ? 'external only'
        : view.kind === 'results'
          ? 'local results'
          : view.kind === 'loading'
            ? 'checking embed'
            : 'in HII';

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-900/10 px-2 py-1.5">
        <button
          type="button"
          onClick={() => goHistory(-1)}
          disabled={history.index <= 0}
          aria-label="back"
          className="grid h-5 w-5 shrink-0 place-items-center rounded font-mono text-[12px] text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-default disabled:opacity-25"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => goHistory(1)}
          disabled={history.index < 0 || history.index >= history.entries.length - 1}
          aria-label="forward"
          className="grid h-5 w-5 shrink-0 place-items-center rounded font-mono text-[12px] text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-default disabled:opacity-25"
        >
          →
        </button>
        <button
          type="button"
          onClick={reload}
          disabled={view.kind !== 'page' && view.kind !== 'blocked'}
          aria-label="reload"
          className="grid h-5 w-5 shrink-0 place-items-center rounded font-mono text-[12px] text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-default disabled:opacity-25"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={goHome}
          aria-label="HII browser home"
          className="grid h-5 w-5 shrink-0 place-items-center rounded font-mono text-[11px] font-semibold text-[var(--hii-graphite)] transition-colors hover:bg-neutral-100"
        >
          h
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(input);
            e.stopPropagation();
          }}
          placeholder="url or search…"
          spellCheck={false}
          className="w-full bg-transparent font-mono text-[11px] text-[var(--hii-graphite)] outline-none placeholder:text-neutral-300"
        />
        <span className="shrink-0 rounded-full border border-neutral-900/10 px-2 py-0.5 font-mono text-[9px] lowercase text-neutral-400">
          {status}
        </span>
      </div>
      <div className="scroll relative min-h-0 flex-1 overflow-auto">
        {view.kind === 'idle' && (
          <div className="grid h-full place-items-center p-6">
            <div className="max-w-sm text-center">
              <div className="font-mono text-[12px] font-medium text-[var(--hii-graphite)]">browser, inside HII</div>
              <div className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                open a web address or search without leaving the workspace
              </div>
            </div>
          </div>
        )}
        {view.kind === 'loading' && (
          <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">loading {view.url}…</div>
        )}
        {view.kind === 'error' && (
          <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-500">{view.message}</div>
        )}
        {view.kind === 'page' && (
          embedMode === 'native' ? (
            <div ref={nativeFrameRef} className="grid h-full w-full place-items-center bg-white font-mono text-[10px] text-neutral-300">
              native browser embedded in HII
            </div>
          ) : (
            <iframe
              key={frameKey}
              src={view.url}
              onLoad={iframeLoaded}
              sandbox="allow-scripts allow-same-origin allow-forms"
              referrerPolicy="no-referrer"
              title={view.url}
              className="h-full w-full border-0"
            />
          )
        )}
        {view.kind === 'blocked' && (
          <div className="grid h-full place-items-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-neutral-900/10 p-4 text-center">
              <div className="mx-auto mb-2 grid h-6 w-6 place-items-center rounded-full border border-neutral-900/10 font-mono text-[12px] text-neutral-400">↗</div>
              <div className="text-[13px] font-medium text-[var(--hii-graphite)]">this site blocks in-app browsing</div>
              <div className="mt-1 break-all font-mono text-[10px] text-neutral-500">{view.url}</div>
              <div className="mt-2 text-[11px] leading-relaxed text-neutral-400">
                HII keeps pages embedded when the site permits it. This page requires an external browser.
              </div>
              <button
                onClick={() => openExternal(view.url)}
                disabled={externalState === 'opening'}
                className="mt-3 rounded-full bg-[var(--hii-graphite)] px-4 py-1.5 font-mono text-[11px] text-white transition-opacity hover:opacity-80"
              >
                {externalState === 'opening' ? 'opening…' : externalState === 'opened' ? 'opened externally' : 'open externally'}
              </button>
              {externalState === 'error' && <div className="mt-2 font-mono text-[10px] text-red-600">could not open the external browser</div>}
            </div>
          </div>
        )}
        {view.kind === 'results' && (
          <div className="divide-y divide-neutral-900/5">
            {view.results.length === 0 && (
              <div className="p-4 font-mono text-[11px] text-neutral-400">no results for “{view.query}”</div>
            )}
            {view.results.map((result) => (
              <button
                key={result.url}
                onClick={() => {
                  setInput(result.url);
                  navigate(result.url);
                }}
                className="block w-full px-4 py-3 text-left transition-colors hover:bg-neutral-50"
              >
                <div className="text-[13px] font-medium text-[var(--hii-electric-blue)]">{result.title}</div>
                <div className="truncate font-mono text-[10px] text-neutral-400">{result.url}</div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-neutral-600">{result.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
