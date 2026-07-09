'use client';

import { FormEvent, useMemo, useState, useTransition } from 'react';
import type { BoardLane, BoardPriority, BoardTask } from '@/lib/server/hii-board';

const lanes: BoardLane[] = ['backlog', 'next', 'doing', 'blocked', 'done'];
const priorities: BoardPriority[] = ['low', 'normal', 'high', 'urgent'];

function laneLabel(lane: BoardLane) {
  if (lane === 'next') return 'next';
  if (lane === 'doing') return 'doing';
  if (lane === 'blocked') return 'blocked';
  if (lane === 'done') return 'done';
  return 'backlog';
}

export function BoardClient({ initialTasks }: { initialTasks: BoardTask[] }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [title, setTitle] = useState('');
  const [lane, setLane] = useState<BoardLane>('next');
  const [priority, setPriority] = useState<BoardPriority>('normal');
  const [coordinate, setCoordinate] = useState('/Users/ummi/hii');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  const visibleTasks = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) =>
      [task.title, task.owner, task.coordinate, task.notes, task.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [filter, tasks]);

  async function refresh() {
    const res = await fetch('/api/board/tasks?includeDone=1', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Could not refresh board.');
    setTasks(data.tasks ?? []);
  }

  function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    startTransition(async () => {
      try {
        const res = await fetch('/api/board/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, lane, priority, coordinate })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Could not add task.');
        setTitle('');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not add task.');
      }
    });
  }

  function moveTask(id: string, nextLane: BoardLane) {
    setError('');
    startTransition(async () => {
      try {
        const res = await fetch('/api/board/tasks', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, lane: nextLane })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Could not move task.');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not move task.');
      }
    });
  }

  return (
    <div className="space-y-5">
      <form onSubmit={addTask} className="hii-card grid gap-2 md:grid-cols-[minmax(0,1fr)_110px_120px_220px_88px]">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="add task"
          className="hii-field min-h-10 px-3 font-mono text-sm"
        />
        <select
          value={lane}
          onChange={(event) => setLane(event.target.value as BoardLane)}
          className="hii-select min-h-10 px-2 font-mono text-sm"
        >
          {lanes.filter((item) => item !== 'done').map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value as BoardPriority)}
          className="hii-select min-h-10 px-2 font-mono text-sm"
        >
          {priorities.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <input
          value={coordinate}
          onChange={(event) => setCoordinate(event.target.value)}
          placeholder="coordinate"
          className="hii-field min-h-10 px-3 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={isPending}
          className="hii-command-button min-h-10 px-3 disabled:opacity-50"
        >
          add
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-3 border-y border-[var(--hii-electric-blue)] py-2">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter"
          className="hii-field h-9 w-full max-w-sm px-3 font-mono text-sm"
        />
        <code className="text-xs text-neutral-600">hii board add &quot;ship Kepler importer&quot; --lane next --priority high</code>
        {error && <span className="font-mono text-xs text-red-600">{error}</span>}
      </div>

      <div className="grid gap-3 xl:grid-cols-5">
        {lanes.map((currentLane) => {
          const laneTasks = visibleTasks.filter((task) => task.lane === currentLane);
          return (
            <section key={currentLane} className="hii-card min-h-80 p-0">
              <div className="flex items-center justify-between border-b border-[rgba(23,107,255,0.24)] px-3 py-2">
                <h2 className="font-mono text-sm font-bold">{laneLabel(currentLane)}</h2>
                <span className="font-mono text-xs text-neutral-500">{laneTasks.length}</span>
              </div>
              <div className="divide-y divide-[rgba(23,107,255,0.12)]">
                {laneTasks.map((task) => (
                  <article key={task.id} className="space-y-3 p-3">
                    <div>
                      <div className="font-mono text-[11px] text-neutral-500">
                        {task.id.slice(0, 8)} / {task.priority} / {task.owner}
                      </div>
                      <h3 className="mt-1 text-sm font-semibold leading-snug">{task.title}</h3>
                      <p className="mt-1 break-all font-mono text-[11px] text-neutral-500">{task.coordinate}</p>
                    </div>
                    {task.notes && <p className="text-xs leading-relaxed text-neutral-600">{task.notes}</p>}
                    {task.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {task.tags.map((tag) => (
                          <span key={tag} className="border border-[rgba(23,107,255,0.24)] bg-[var(--hii-warm-white)] px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {lanes.filter((item) => item !== task.lane).map((item) => (
                        <button
                          key={item}
                          type="button"
                          disabled={isPending}
                          onClick={() => moveTask(task.id, item)}
                          className="border border-[rgba(23,107,255,0.34)] px-2 py-1 font-mono text-[11px] text-[var(--hii-electric-blue)] hover:bg-[var(--hii-soft-blue)] disabled:opacity-50"
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
                {laneTasks.length === 0 && <div className="p-3 font-mono text-xs text-neutral-400">empty</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
