'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type BrowserNodeProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

type SearchResult = { title: string; url: string; description: string };

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
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  const navigate = useCallback(async (rawUrl: string) => {
    const url = normalizeUrl(rawUrl) ?? rawUrl;
    setView({ kind: 'loading', url });
    onPayloadRef.current({ url, title: (() => { try { return new URL(url).hostname; } catch { return url; } })() });
    try {
      const res = await fetch(`/api/browse/check?url=${encodeURIComponent(url)}`);
      const data = (await res.json()) as { frameable?: boolean; finalUrl?: string };
      const finalUrl = data.finalUrl || url;
      if (!data.frameable) {
        setView({ kind: 'blocked', url: finalUrl });
        return;
      }
      setView({ kind: 'page', url: finalUrl });
      if (loadTimer.current) clearTimeout(loadTimer.current);
      loadTimer.current = setTimeout(() => {
        setView((current) => (current.kind === 'page' && current.url === finalUrl ? { kind: 'blocked', url: finalUrl } : current));
      }, 10_000);
    } catch {
      setView({ kind: 'error', message: 'probe failed' });
    }
  }, []);

  const search = useCallback(async (query: string) => {
    setView({ kind: 'loading', url: `search: ${query}` });
    onPayloadRef.current({ query, title: `search: ${query}` });
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = (await res.json()) as { results?: SearchResult[]; error?: string };
      if (!res.ok || !data.results) {
        setView({ kind: 'error', message: data.error ?? 'search failed' });
        return;
      }
      setView({ kind: 'results', query, results: data.results });
    } catch {
      setView({ kind: 'error', message: 'search failed' });
    }
  }, []);

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

  // restore persisted state on mount
  useEffect(() => {
    const url = node.payload.url;
    const query = node.payload.query;
    if (typeof url === 'string' && url) navigate(url);
    else if (typeof query === 'string' && query) search(query);
    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const iframeLoaded = () => {
    if (loadTimer.current) clearTimeout(loadTimer.current);
  };

  const openExternal = (url: string) => {
    fetch('/api/files/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
  };

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-900/10 px-2 py-1.5">
        <span className="font-mono text-[10px] text-neutral-400">⌕</span>
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
      </div>
      <div className="scroll relative min-h-0 flex-1 overflow-auto">
        {view.kind === 'idle' && (
          <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-300">type a url or a search query</div>
        )}
        {view.kind === 'loading' && (
          <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">loading {view.url}…</div>
        )}
        {view.kind === 'error' && (
          <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] text-neutral-500">{view.message}</div>
        )}
        {view.kind === 'page' && (
          <iframe
            src={view.url}
            onLoad={iframeLoaded}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            title={view.url}
            className="h-full w-full border-0"
          />
        )}
        {view.kind === 'blocked' && (
          <div className="grid h-full place-items-center p-6">
            <div className="w-full max-w-sm rounded-lg border border-neutral-900/10 p-4 text-center">
              <img
                src={`https://icons.duckduckgo.com/ip3/${(() => { try { return new URL(view.url).hostname; } catch { return ''; } })()}.ico`}
                alt=""
                className="mx-auto mb-2 h-6 w-6"
              />
              <div className="text-[13px] font-medium text-[var(--hii-graphite)]">this site refuses to be embedded</div>
              <div className="mt-1 break-all font-mono text-[10px] text-neutral-500">{view.url}</div>
              <button
                onClick={() => openExternal(view.url)}
                className="mt-3 rounded-full bg-[var(--hii-graphite)] px-4 py-1.5 font-mono text-[11px] text-white transition-opacity hover:opacity-80"
              >
                open in Helium
              </button>
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
