'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type ContextNodeProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

type HiiContext = {
  generatedAt?: string;
  git?: { branch?: string; status?: string[] };
  capabilities?: Array<{ id: string; name: string; status: string }>;
  nextActions?: Array<{ score?: number; track?: string; next?: string }>;
};

export default function ContextNode(_props: ContextNodeProps) {
  const [ctx, setCtx] = useState<HiiContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/context', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setCtx(await res.json());
      setError(null);
    } catch {
      setError('context unavailable');
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (error) return <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">{error}</div>;
  if (!ctx) return <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">reading ~/.hii…</div>;

  const dirty = ctx.git?.status?.length ?? 0;

  return (
    <div className="scroll h-full overflow-auto p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">system context</span>
        <button onClick={refresh} className="font-mono text-[10px] text-neutral-400 hover:text-[var(--hii-electric-blue)]">
          refresh
        </button>
      </div>
      <div className="mt-2.5 rounded-md border border-neutral-900/10 px-3 py-2">
        <div className="font-mono text-[11px] text-[var(--hii-graphite)]">{ctx.git?.branch ?? 'no branch'}</div>
        <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
          {dirty === 0 ? 'clean tree' : `${dirty} dirty path${dirty === 1 ? '' : 's'}`}
        </div>
      </div>
      {ctx.nextActions && ctx.nextActions.length > 0 && (
        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">next</div>
          <ul className="mt-1.5 space-y-1.5">
            {ctx.nextActions.slice(0, 4).map((action, i) => (
              <li key={i} className="text-[12px] leading-snug text-neutral-700">
                <span className="mr-1.5 font-mono text-[10px] text-[var(--hii-electric-blue)]">{action.track}</span>
                {action.next}
              </li>
            ))}
          </ul>
        </div>
      )}
      {ctx.capabilities && ctx.capabilities.length > 0 && (
        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">capabilities</div>
          <ul className="mt-1.5 space-y-1">
            {ctx.capabilities.slice(0, 8).map((cap) => (
              <li key={cap.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate font-mono text-neutral-600">{cap.id}</span>
                <span className={`shrink-0 font-mono text-[10px] ${cap.status === 'ready' ? 'text-emerald-600' : 'text-neutral-400'}`}>
                  {cap.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ctx.generatedAt && (
        <div className="mt-3 font-mono text-[9px] text-neutral-300">{new Date(ctx.generatedAt).toLocaleTimeString()}</div>
      )}
    </div>
  );
}
