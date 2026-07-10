'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type DaemonEvent = {
  id: string;
  ts: string;
  type: string;
  status?: string;
  text?: string;
  loop?: string;
  target?: string;
};

type DaemonInstance = {
  id: string;
  type: string;
  title?: string;
  pid?: number | null;
  status: string;
  owned?: boolean;
  autonomy?: string;
  coordinate?: string;
  heartbeatAt?: string | null;
};

type DaemonRun = {
  id: string;
  status: string;
  title?: string;
  prompt: string;
  updatedAt: string;
  exitCode?: number | null;
};

type DaemonSnapshot = {
  alive: boolean;
  status: {
    state?: string;
    pid?: number | null;
    updatedAt?: string | null;
    autonomy?: string;
    counts?: {
      instances?: number;
      active?: number;
      blocked?: number;
      queued?: number;
      events?: number;
    };
  };
  instances: DaemonInstance[];
  events: DaemonEvent[];
  runs: DaemonRun[];
};

type DaemonButtonProps = {
  onPin: (event: DaemonEvent) => void;
};

function timeLabel(value?: string | null) {
  if (!value) return 'never';
  try {
    return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch {
    return value;
  }
}

function statusTone(snapshot: DaemonSnapshot | null, error: string | null) {
  if (error || !snapshot?.alive) return 'bg-neutral-900 text-white';
  const blocked = snapshot.status.counts?.blocked ?? 0;
  const active = snapshot.status.counts?.active ?? 0;
  if (blocked > 0) return 'bg-amber-500 text-white';
  if (active > 1) return 'bg-[var(--hii-electric-blue)] text-white';
  return 'bg-white text-[var(--hii-graphite)]';
}

export function DaemonButton({ onPin }: DaemonButtonProps) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/daemon', { cache: 'no-store' });
      if (!res.ok) throw new Error(`daemon ${res.status}`);
      setSnapshot((await res.json()) as DaemonSnapshot);
      setError(null);
    } catch {
      setError('offline');
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, open ? 3000 : 8000);
    return () => clearInterval(interval);
  }, [open, refresh]);

  const act = useCallback(
    async (action: string, body: Record<string, unknown> = {}) => {
      setBusy(true);
      try {
        const res = await fetch('/api/daemon', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...body })
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (data.snapshot) setSnapshot(data.snapshot as DaemonSnapshot);
        setError(null);
      } catch {
        setError('action failed');
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh]
  );

  const counts = snapshot?.status.counts;
  const recent = useMemo(() => snapshot?.events.slice(0, 18) ?? [], [snapshot]);
  const instances = useMemo(() => snapshot?.instances.slice(0, 16) ?? [], [snapshot]);
  const runs = useMemo(() => snapshot?.runs.slice(0, 8) ?? [], [snapshot]);

  return (
    <div data-canvas-ui className="absolute right-5 top-4 z-50">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onPointerDown={(event) => event.stopPropagation()}
        className={`flex items-center gap-2 rounded-full px-3 py-2 font-mono text-[11px] shadow-[0_0_0_1px_rgba(23,23,23,0.12),0_8px_24px_rgba(23,23,23,0.08)] transition ${statusTone(snapshot, error)}`}
        title="HII daemon"
      >
        <span className={`h-2 w-2 rounded-full ${snapshot?.alive ? 'bg-emerald-400' : 'bg-neutral-400'}`} />
        hiid
        {counts?.active ? <span className="opacity-70">{counts.active}</span> : null}
      </button>

      {open && (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          className="mt-2 flex max-h-[calc(100vh-96px)] w-[min(520px,calc(100vw-40px))] flex-col overflow-hidden rounded-lg bg-white shadow-[0_0_0_1px_rgba(23,23,23,0.12),0_18px_70px_rgba(23,23,23,0.18)]"
        >
          <div className="flex items-center justify-between border-b border-neutral-900/10 px-4 py-3">
            <div>
              <div className="font-mono text-[12px] font-semibold text-[var(--hii-graphite)]">HII daemon</div>
              <div className="mt-0.5 font-mono text-[10px] text-neutral-400">
                {snapshot?.alive ? `pid ${snapshot.status.pid}` : error || 'stopped'} · {snapshot?.status.autonomy ?? 'reversible-local'}
              </div>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => act(snapshot?.alive ? 'restart' : 'start')}
                className="rounded-md border border-neutral-900/10 px-2.5 py-1 font-mono text-[10px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
              >
                {snapshot?.alive ? 'restart' : 'start'}
              </button>
              <button
                type="button"
                disabled={busy || !snapshot?.alive}
                onClick={() => act('stop')}
                className="rounded-md border border-neutral-900/10 px-2.5 py-1 font-mono text-[10px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
              >
                stop
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 border-b border-neutral-900/10">
            {[
              ['active', counts?.active ?? 0],
              ['queued', counts?.queued ?? 0],
              ['blocked', counts?.blocked ?? 0],
              ['events', counts?.events ?? recent.length]
            ].map(([label, value]) => (
              <div key={label} className="border-r border-neutral-900/10 px-3 py-2 last:border-r-0">
                <div className="font-mono text-[15px] text-[var(--hii-graphite)]">{value}</div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-neutral-400">{label}</div>
              </div>
            ))}
          </div>

          <div className="scroll grid min-h-0 flex-1 grid-cols-[190px_1fr] overflow-auto">
            <div className="border-r border-neutral-900/10 p-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">instances</div>
              <div className="mt-2 space-y-1.5">
                {instances.length === 0 && <div className="font-mono text-[11px] text-neutral-400">no snapshot yet</div>}
                {instances.map((instance) => (
                  <div key={instance.id} className="rounded-md border border-neutral-900/10 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-neutral-700">{instance.title || instance.id}</span>
                      <span className={instance.status === 'running' ? 'font-mono text-[9px] text-emerald-600' : 'font-mono text-[9px] text-neutral-400'}>
                        {instance.status}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-neutral-400">
                      {instance.type} · {instance.owned ? 'owned' : 'observed'} {instance.pid ? `· ${instance.pid}` : ''}
                    </div>
                  </div>
                ))}
              </div>

              <form
                className="mt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!prompt.trim()) return;
                  act('codex.run', { prompt });
                  setPrompt('');
                }}
              >
                <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">codex run</div>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Queue managed work..."
                  className="mt-2 h-20 w-full resize-none rounded-md border border-neutral-900/10 px-2.5 py-2 text-[12px] outline-none focus:border-[var(--hii-electric-blue)]"
                />
                <button
                  type="submit"
                  disabled={busy || !prompt.trim()}
                  className="mt-1.5 w-full rounded-md bg-[var(--hii-graphite)] px-2.5 py-1.5 font-mono text-[10px] text-white disabled:opacity-40"
                >
                  queue
                </button>
              </form>

              {runs.length > 0 && (
                <div className="mt-4">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">runs</div>
                  <div className="mt-2 space-y-1.5">
                    {runs.map((run) => (
                      <div key={run.id} className="rounded-md bg-neutral-50 px-2.5 py-2">
                        <div className="truncate text-[11px] text-neutral-700">{run.title || run.prompt}</div>
                        <div className="mt-0.5 font-mono text-[9px] text-neutral-400">
                          {run.status} · {timeLabel(run.updatedAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-3">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">live feed</div>
                <button
                  type="button"
                  onClick={refresh}
                  className="font-mono text-[10px] text-neutral-400 hover:text-[var(--hii-electric-blue)]"
                >
                  refresh
                </button>
              </div>
              <div className="mt-2 space-y-2">
                {recent.length === 0 && <div className="font-mono text-[11px] text-neutral-400">no daemon events yet</div>}
                {recent.map((event) => (
                  <div key={event.id} className="group rounded-md border border-neutral-900/10 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[10px] text-neutral-400">
                          {timeLabel(event.ts)} · {event.type} {event.status ? `· ${event.status}` : ''}
                        </div>
                        <div className="mt-1 text-[12px] leading-snug text-neutral-700">{event.text || event.target || event.type}</div>
                        {event.loop && <div className="mt-1 font-mono text-[9px] text-neutral-400">{event.loop}</div>}
                      </div>
                      <button
                        type="button"
                        onClick={() => onPin(event)}
                        className="shrink-0 rounded-md px-1.5 py-1 font-mono text-[9px] text-neutral-300 opacity-0 hover:bg-neutral-50 hover:text-[var(--hii-electric-blue)] group-hover:opacity-100"
                      >
                        pin
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
