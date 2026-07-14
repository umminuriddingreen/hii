'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type BoardNodeProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

type BoardTask = {
  id: string;
  title: string;
  lane: string;
  priority: string;
  coordinate: string;
  updatedAt: string;
};

const laneOrder = ['doing', 'next', 'blocked', 'backlog', 'done'];

export default function BoardNode(_props: BoardNodeProps) {
  const [tasks, setTasks] = useState<BoardTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/board/tasks', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { tasks?: BoardTask[] };
      setTasks(data.tasks ?? []);
      setError(null);
    } catch {
      setError('board unavailable');
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 20_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (error) return <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">{error}</div>;
  if (!tasks) return <div className="grid h-full place-items-center font-mono text-[11px] text-neutral-400">reading board…</div>;

  const lanes = laneOrder
    .map((lane) => ({ lane, items: tasks.filter((task) => task.lane === lane) }))
    .filter(({ lane, items }) => items.length > 0 && lane !== 'done');

  return (
    <div className="scroll h-full overflow-auto p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">board</span>
        <a href="/boards" className="font-mono text-[10px] text-neutral-400 hover:text-[var(--hii-electric-blue)]">
          open ↗
        </a>
      </div>
      {lanes.length === 0 && <div className="mt-4 font-mono text-[11px] text-neutral-400">no active tasks</div>}
      {lanes.map(({ lane, items }) => (
        <div key={lane} className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">
            {lane} <span className="text-neutral-300">{items.length}</span>
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {items.slice(0, 6).map((task) => (
              <li key={task.id} className="rounded-md border border-neutral-900/10 px-2.5 py-1.5">
                <div className="text-[12px] leading-snug text-neutral-700">{task.title}</div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[9px] text-neutral-400">
                  <span className={task.priority === 'high' || task.priority === 'urgent' ? 'text-[var(--hii-electric-blue)]' : ''}>
                    {task.priority}
                  </span>
                  {task.coordinate && <span className="truncate">{task.coordinate.replace('/Users/ummi', '~')}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
