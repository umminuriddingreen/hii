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

type Command = {
  label: string;
  href?: string;
  api?: string;
  lines?: string[];
  group: 'social' | 'studio' | 'terminal' | 'services' | 'system';
};

const helpLines = [
  'social    /feed /boards /home /post',
  'studio    /studio /dashboard /upload /x',
  'terminal  /terminal /sessions',
  'services  /credits /jobs /capabilities /termite',
  'system    /context /og /loop /installer /login',
  'tip       type commands with or without /'
];

const commands: Record<string, Command> = {
  '/help': { label: 'show command index', lines: helpLines, group: 'system' },
  '/': { label: 'show command index', lines: helpLines, group: 'system' },

  '/feed': { label: 'open home feed', href: '/feed', group: 'social' },
  '/home': { label: 'open home feed', href: '/feed', group: 'social' },
  '/boards': { label: 'open boards', href: '/boards', group: 'social' },
  '/post': { label: 'create post', href: '/upload', group: 'social' },

  '/studio': { label: 'creator studio', href: '/dashboard', group: 'studio' },
  '/dashboard': { label: 'creator studio', href: '/dashboard', group: 'studio' },
  '/upload': { label: 'publish asset', href: '/upload', group: 'studio' },
  '/new': { label: 'publish asset', href: '/upload', group: 'studio' },
  '/x': { label: 'open an exchange item by id: /x/<id>', lines: ['paste a full /x/<id> link or open from feed'], group: 'studio' },

  '/terminal': { label: 'open terminal', href: '/terminal', group: 'terminal' },
  '/sessions': { label: 'terminal sessions', api: '/api/terminal/sessions', group: 'terminal' },
  '/agents': { label: 'terminal sessions', api: '/api/terminal/sessions', group: 'terminal' },

  '/credits': { label: 'quote capability work', href: '/credits', group: 'services' },
  '/account': { label: 'credit account', api: '/api/credits/account', group: 'services' },
  '/jobs': { label: 'capability jobs', api: '/api/capabilities/jobs', group: 'services' },
  '/capabilities': { label: 'capability catalog', api: '/api/capabilities', group: 'services' },
  '/packs': { label: 'capability catalog', api: '/api/capabilities', group: 'services' },
  '/termite': { label: 'termite alpha', href: '/termite', group: 'services' },
  '/installer': { label: 'termite installer state', api: '/api/termite/installer', group: 'services' },
  '/termite-jobs': { label: 'termite jobs', api: '/api/termite/jobs', group: 'services' },

  '/login': { label: 'sign in', href: '/login', group: 'system' },
  '/signin': { label: 'sign in', href: '/login', group: 'system' },
  '/og': { label: 'operational graph', api: '/api/og/status', group: 'system' },
  '/loop': { label: 'propose next plan', api: '/api/og/status', group: 'system' },
  '/context': { label: 'agent context', api: '/api/context', group: 'system' }
};

function normalizeCommand(input: string) {
  const key = input.trim().toLowerCase();
  if (!key) return '/';
  if (key.startsWith('/x/')) return key;
  return key.startsWith('/') ? key : `/${key}`;
}

function displayCommand(command: string) {
  return command === '/' ? '/help' : command;
}

export function HiiNew() {
  const [name, setName] = useState('');
  const [knownName, setKnownName] = useState('');
  const [command, setCommand] = useState('');
  const [spawned, setSpawned] = useState<SpawnedCommand[]>([]);

  const suggestions = useMemo(() => {
    const key = normalizeCommand(command || '/');
    const pool = Object.keys(commands).filter((item) => item !== '/');
    if (key === '/') return ['/feed', '/boards', '/post', '/studio', '/terminal', '/capabilities', '/credits', '/help'];
    return pool.filter((item) => item.startsWith(key)).slice(0, 10);
  }, [command]);

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = name.trim();
    if (next) setKnownName(next);
  }

  function formatApiLines(key: string, data: Record<string, unknown>) {
    if (key === '/og' || key === '/loop') {
      const nextActions = Array.isArray(data.nextActions) ? data.nextActions : [];
      return [
        `branch ${String(data.branch ?? 'unknown')}`,
        `dirty ${String(data.dirtyFiles ?? 0)}`,
        key === '/loop' ? 'gate y/n before action' : 'mode observe',
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
    if (key === '/capabilities' || key === '/packs') {
      const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
      return [
        `${capabilities.length} capabilities`,
        ...capabilities.slice(0, 8).map((capability) => {
          const item = capability as { id?: string; status?: string; visibility?: string };
          return `${item.status ?? 'unknown'} ${item.id ?? 'capability'} ${item.visibility ?? ''}`.trim();
        })
      ];
    }
    if (key === '/jobs' || key === '/termite-jobs') {
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const warning = typeof data.warning === 'string' ? data.warning : null;
      return [
        `${jobs.length} jobs`,
        ...(warning ? [warning] : []),
        ...jobs.slice(0, 6).map((job) => {
          const item = job as { id?: string; status?: string; capability_id?: string; capabilityId?: string; input_summary?: string; inputSummary?: string };
          return `${item.status ?? 'unknown'} ${(item.capability_id ?? item.capabilityId ?? 'job')} ${(item.input_summary ?? item.inputSummary ?? item.id ?? '').toString().slice(0, 64)}`;
        })
      ];
    }
    if (key === '/sessions' || key === '/agents') {
      const agents = Array.isArray(data.agents) ? data.agents : [];
      return [
        `${agents.length} terminal sessions`,
        ...agents.slice(0, 8).map((agent) => {
          const item = agent as { name?: string; pid?: number; status?: string; title?: string };
          return `${item.status ?? 'seen'} ${item.name ?? item.title ?? 'agent'} ${item.pid ?? ''}`.trim();
        })
      ];
    }
    if (key === '/account') {
      const account = data.account as { balance_cents?: number; reserved_cents?: number; currency?: string } | undefined;
      if (data.error) return [String(data.error)];
      return [
        `balance ${account?.balance_cents ?? 0} ${account?.currency ?? 'usd'}`,
        `reserved ${account?.reserved_cents ?? 0}`,
        data.warning ? String(data.warning) : 'account ready'
      ];
    }
    if (key === '/installer') {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const state = data.state as { installed?: boolean; running?: boolean } | undefined;
      return [
        `installed ${String(state?.installed ?? 'unknown')}`,
        `running ${String(state?.running ?? 'unknown')}`,
        `${actions.length} installer actions`
      ];
    }
    if (data.error) return [String(data.error)];
    return ['done'];
  }

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = normalizeCommand(command);
    if (key.startsWith('/x/')) {
      setSpawned((current) => [
        ...current,
        {
          id: Date.now(),
          command: key,
          label: 'open exchange item',
          href: key
        }
      ]);
      setCommand('');
      return;
    }

    const item = commands[key] ?? { label: key ? `spawn ${key}` : 'waiting', group: 'terminal' as const };
    const id = Date.now();
    setSpawned((current) => [
      ...current,
      {
        id,
        command: displayCommand(key),
        label: item.label,
        href: item.href,
        lines: item.lines ?? (item.api ? ['loading'] : undefined)
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
                onClick={() => setCommand(item.slice(1))}
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
