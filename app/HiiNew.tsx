'use client';

import Link from 'next/link';
import { FormEvent, useMemo, useState } from 'react';
import { AliveBars } from './AliveBars';

type SpawnedCommand = {
  id: number;
  command: string;
  label: string;
  href?: string;
  lines?: string[];
};

const commands: Record<string, { label: string; href?: string; api?: string }> = {
  '/terminal': { label: 'open terminal', href: '/terminal' },
  '/credits': { label: 'quote capability work', href: '/credits' },
  '/termite': { label: 'termite alpha', href: '/termite' },
  '/upload': { label: 'new exchange', href: '/upload' },
  '/dashboard': { label: 'dashboard', href: '/dashboard' },
  '/login': { label: 'sign in', href: '/login' },
  '/og': { label: 'operational graph', api: '/api/og/status' },
  '/context': { label: 'agent context', api: '/api/context' }
};

export function HiiNew() {
  const [name, setName] = useState('');
  const [knownName, setKnownName] = useState('');
  const [command, setCommand] = useState('');
  const [spawned, setSpawned] = useState<SpawnedCommand[]>([]);

  const suggestions = useMemo(
    () => Object.keys(commands).filter((item) => item.startsWith(command || '/')).slice(0, 6),
    [command]
  );

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = name.trim();
    if (next) setKnownName(next);
  }

  function formatApiLines(key: string, data: Record<string, unknown>) {
    if (key === '/og') {
      const nextActions = Array.isArray(data.nextActions) ? data.nextActions : [];
      return [
        `branch ${String(data.branch ?? 'unknown')}`,
        `dirty ${String(data.dirtyFiles ?? 0)}`,
        ...nextActions.slice(0, 3).map((action) => {
          const item = action as { score?: number; track?: string; next?: string };
          return `${item.score ?? 0} ${item.track ?? 'next'}: ${item.next ?? ''}`;
        })
      ];
    }
    if (key === '/context') {
      const identity = data.identity as { repo?: string; runtime?: string } | undefined;
      const capabilities = Array.isArray(data.capabilities) ? data.capabilities.length : 0;
      const nextActions = Array.isArray(data.nextActions) ? data.nextActions : [];
      const first = nextActions[0] as { track?: string; next?: string } | undefined;
      return [
        `repo ${identity?.repo ?? '/Users/ummi/hii'}`,
        `runtime ${identity?.runtime ?? '/Users/ummi/.hii'}`,
        `capabilities ${capabilities}`,
        first ? `next ${first.track}: ${first.next}` : 'next waiting'
      ];
    }
    return ['done'];
  }

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = command.trim().toLowerCase();
    const item = commands[key] ?? { label: key ? `spawn ${key}` : 'waiting' };
    const id = Date.now();
    setSpawned((current) => [
      ...current,
      {
        id,
        command: key || '/',
        label: item.label,
        href: item.href,
        lines: item.api ? ['loading'] : undefined
      }
    ]);
    setCommand('');
    if (item.api) {
      try {
        const response = await fetch(item.api, { cache: 'no-store' });
        const data = (await response.json()) as Record<string, unknown>;
        setSpawned((current) =>
          current.map((spawn) =>
            spawn.id === id ? { ...spawn, lines: formatApiLines(key, data) } : spawn
          )
        );
      } catch {
        setSpawned((current) =>
          current.map((spawn) =>
            spawn.id === id ? { ...spawn, lines: ['failed'] } : spawn
          )
        );
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-white text-black">
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-4">
        <div className="h-2 w-2 rounded-full bg-black animate-pulse" />
        <AliveBars compact />
      </div>

      <div className="absolute left-6 top-6 font-mono text-xs">
        hii
      </div>

      {spawned.length > 0 && (
        <div className="absolute left-6 top-16 space-y-2 font-mono text-sm">
          {spawned.map((item) => (
            <div key={item.id} className="flex gap-3">
              <span>{item.command}</span>
              {item.href ? (
                <Link href={item.href} className="underline underline-offset-4">
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
              {item.lines && (
                <div className="ml-3 space-y-1 text-xs text-neutral-500">
                  {item.lines.map((line) => (
                    <div key={line} className="flex items-center gap-2">
                      {line === 'loading' && <AliveBars compact />}
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!knownName ? (
        <form onSubmit={submitName} className="absolute bottom-6 left-6 right-6 flex items-center gap-3 font-mono text-sm">
          <label htmlFor="name">name</label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            className="min-w-0 flex-1 border-0 border-b border-black bg-transparent px-0 py-1 font-mono outline-none"
            autoComplete="name"
          />
        </form>
      ) : (
        <div className="absolute bottom-6 left-6 right-6 font-mono text-sm">
          <div className="mb-3">hi {knownName}</div>
          <form onSubmit={submitCommand} className="flex items-center gap-3">
            <label htmlFor="command">/</label>
            <input
              id="command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              autoFocus
              className="min-w-0 flex-1 border-0 border-b border-black bg-transparent px-0 py-1 font-mono outline-none"
              placeholder="terminal"
            />
          </form>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-neutral-500">
            {suggestions.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCommand(item)}
                className="font-mono hover:text-black"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
