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
  'context   /context /og /loop /capabilities',
  'work      /feed /boards /upload /x',
  'console   /console /terminal /sessions',
  'services  /credits /jobs /capabilities /termite',
  'system    /context /og /loop /installer /login',
  'gate      prepare first, approve before action'
];

const commands: Record<string, Command> = {
  '/help': { label: 'show command index', lines: helpLines, group: 'system' },
  '/': { label: 'show command index', lines: helpLines, group: 'system' },

  '/feed': { label: 'open link stream', href: '/feed', group: 'social' },
  '/home': { label: 'open link stream', href: '/feed', group: 'social' },
  '/boards': { label: 'open boards', href: '/boards', group: 'social' },
  '/post': { label: 'create exchange item', href: '/upload', group: 'social' },

  '/studio': { label: 'operator dashboard', href: '/dashboard', group: 'studio' },
  '/dashboard': { label: 'operator dashboard', href: '/dashboard', group: 'studio' },
  '/upload': { label: 'create exchange asset', href: '/upload', group: 'studio' },
  '/new': { label: 'create exchange asset', href: '/upload', group: 'studio' },
  '/x': { label: 'open an exchange item by id: /x/<id>', lines: ['paste a full /x/<id> link or open from feed'], group: 'studio' },

  '/console': { label: 'open matrix console', href: '/console', group: 'terminal' },
  '/matrix': { label: 'open matrix console', href: '/console', group: 'terminal' },
  '/terminal': { label: 'open local console', href: '/console', group: 'terminal' },
  '/sessions': { label: 'console sessions', api: '/api/terminal/sessions', group: 'terminal' },
  '/agents': { label: 'console sessions', api: '/api/terminal/sessions', group: 'terminal' },

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

const contextItems = [
  { label: 'Capability registry', value: '22 visible actions', status: 'visible' },
  { label: 'Local runtime', value: '~/.hii receipts', status: 'prepared' },
  { label: 'Approval gate', value: 'proposal before action', status: 'needs you' },
  { label: 'Proof queue', value: 'logs and artifacts', status: 'working' },
  { label: 'Publishing', value: 'explicit push only', status: 'guarded' }
];

const activity = [
  { state: 'done', text: 'Loaded local HII context and capability registry' },
  { state: 'prepared', text: 'Ranked next actions from the operational graph' },
  { state: 'working', text: 'Watching jobs, runners, traces, and proof receipts' },
  { state: 'prepared', text: 'Built a bounded proposal for operator review' },
  { state: 'blocked', text: 'External publish waits for explicit approval' }
];

const memoryCards = [
  { title: 'Contract', body: 'CapabilityDefinition -> Job -> ProofArtifact.', meta: 'source: lib/capabilities' },
  { title: 'Boundary', body: 'Prepare, quote, approve, then execute.', meta: 'trust: operator-reviewed' },
  { title: 'Evidence', body: 'Logs, ledger rows, links, JSON, and receipts.', meta: 'proof: required' }
];

const projectWorlds = [
  'Capabilities',
  'Approvals',
  'Jobs',
  'Runners',
  'Proof'
];

const proofRecommendations = [
  { title: 'Context snapshot', source: 'hii context --json', idea: 'Show repo, runtime, jobs, capabilities, guardrails, and next actions.' },
  { title: 'Capability quote', source: '/api/credits/quote', idea: 'Estimate bounded work before reserving budget or starting execution.' },
  { title: 'Proof receipt', source: '.hii/capability-jobs.jsonl', idea: 'Keep logs, ledger rows, and proof artifacts reviewable after completion.' }
];

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
  const [command, setCommand] = useState('');
  const [spawned, setSpawned] = useState<SpawnedCommand[]>([]);
  const [approvalPending, setApprovalPending] = useState(false);

  const suggestions = useMemo(() => {
    const key = normalizeCommand(command || '/');
    const pool = Object.keys(commands).filter((item) => item !== '/');
    if (key === '/') return ['/context', '/loop', '/capabilities', '/credits', '/boards', '/console'];
    return pool.filter((item) => item.startsWith(key)).slice(0, 8);
  }, [command]);

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
        `${agents.length} console sessions`,
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
        {
          id: Date.now(),
          command: key,
          label: 'open exchange item',
          href: key
        },
        ...current
      ]);
      setCommand('');
      return;
    }

    const item = commands[key] ?? { label: key ? `prepare ${key}` : 'waiting', group: 'terminal' as const };
    const id = Date.now();
    setSpawned((current) => [
      {
        id,
        command: displayCommand(key),
        label: item.label,
        href: item.href,
        lines: item.lines ?? (item.api ? ['loading'] : undefined)
      },
      ...current
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

  function pushReceipt(receipt: Omit<SpawnedCommand, 'id'>) {
    setSpawned((current) => [{ id: Date.now(), ...receipt }, ...current]);
  }

  async function createBoardReceipt(action: 'approve' | 'skip') {
    setApprovalPending(true);
    const approved = action === 'approve';
    try {
      const response = await fetch('/api/board/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: approved
            ? 'Run HII SDK maturity proof pass'
            : 'Skipped HII SDK maturity proof pass',
          lane: approved ? 'doing' : 'done',
          priority: approved ? 'high' : 'normal',
          owner: 'HII Control Plane',
          coordinate: '/',
          tags: ['desk', 'approval', 'proof'],
          notes: approved
            ? 'User approved the prepared next move from HII Control Plane. Keep action local until a later publish/export approval.'
            : 'User skipped the prepared next move from HII Control Plane. Keep the receipt for memory and future context.'
        })
      });
      const data = (await response.json()) as { task?: { id?: string }; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not write board receipt.');
      pushReceipt({
        command: approved ? 'approve' : 'skip',
        label: approved ? 'saved approved next move to board' : 'saved skipped next move to board',
        href: '/boards',
        lines: [
          `board ${data.task?.id?.slice(0, 8) ?? 'created'}`,
          approved ? 'lane doing / no publish action' : 'lane done / skipped receipt'
        ]
      });
    } catch (error) {
      pushReceipt({
        command: action,
        label: 'approval receipt failed',
        lines: [error instanceof Error ? error.message : 'Could not write board receipt.']
      });
    } finally {
      setApprovalPending(false);
    }
  }

  function editNextMove() {
    setCommand('run hii sdk maturity proof pass');
    pushReceipt({
      command: 'edit',
      label: 'loaded next move into control inbox',
      lines: ['revise the request, then press Prepare']
    });
  }

  return (
    <div className="hii-desk fixed inset-0 z-50 overflow-auto bg-[var(--hii-warm-white)] text-[var(--hii-graphite)]">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
        <Link href="/" className="font-mono text-sm font-semibold tracking-normal">
          hii
        </Link>
        <nav className="hidden items-center gap-4 font-mono text-xs text-neutral-500 md:flex">
          <Link href="/landing" className="hover:text-black">playbook</Link>
          <Link href="/boards" className="hover:text-black">boards</Link>
          <Link href="/console" className="hover:text-black">matrix</Link>
          <Link href="/credits" className="hover:text-black">credits</Link>
        </nav>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="hii-status-dot" />
          control plane
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl gap-4 px-5 pb-6 sm:px-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <section className="space-y-4">
          <div className="hii-panel hii-hero-panel overflow-hidden p-5 sm:p-7">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="min-w-0">
                <p className="hii-kicker">HII control desk</p>
                <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.03] sm:text-6xl">
                  Name the work. HII keeps the proof.
                </h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-neutral-600">
                  A local-first desk for capability work, approvals, jobs, runners, traces, proofs, and receipts. HII turns intent into a bounded path, shows its references, and prepares the next move for review.
                </p>
              </div>

              <div className="hii-world-orbit" aria-label="project world lanes">
                {projectWorlds.map((world, index) => (
                  <span key={world} style={{ ['--i' as string]: index }}>
                    {world}
                  </span>
                ))}
              </div>
            </div>

            <form onSubmit={submitCommand} className="mt-7">
              <label htmlFor="command" className="mb-2 block font-mono text-xs text-neutral-500">
                control inbox
              </label>
              <div className="flex min-h-14 items-center gap-3 border border-neutral-300 bg-white px-4 shadow-[0_14px_34px_rgba(20,24,28,0.08)]">
                <span className="font-mono text-neutral-400">/</span>
                <input
                  id="command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  className="min-w-0 flex-1 border-0 bg-transparent py-4 text-base outline-none"
                  placeholder="ask for context, capabilities, jobs, proof, or a bounded task"
                />
                <button type="submit" className="hii-command-button">
                  Prepare
                </button>
              </div>
            </form>

            <div className="mt-4 flex flex-wrap gap-2">
              {suggestions.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setCommand(item.slice(1))}
                  className="hii-shortcut"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(260px,0.55fr)]">
            <section className="hii-panel p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-xs uppercase text-neutral-500">today's next move</p>
                  <h2 className="mt-2 text-2xl font-semibold">Run HII SDK maturity proof pass</h2>
                </div>
                <span className="hii-risk-label">needs approval</span>
              </div>
              <p className="mt-4 text-sm leading-6 text-neutral-600">
                Source context: capability registry, local job log, operational graph, terminal stream, credits quote path, Termite runner path, and the public playbook. HII prepared a local validation pass. Nothing pushes, publishes, spends, or mutates external services until you approve.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <button
                  className="hii-primary-action"
                  type="button"
                  disabled={approvalPending}
                  onClick={() => void createBoardReceipt('approve')}
                >
                  Approve
                </button>
                <button className="hii-secondary-action" type="button" onClick={editNextMove}>
                  Edit
                </button>
                <button
                  className="hii-secondary-action"
                  type="button"
                  disabled={approvalPending}
                  onClick={() => void createBoardReceipt('skip')}
                >
                  Skip
                </button>
              </div>
            </section>

            <section className="hii-panel p-5">
              <p className="font-mono text-xs uppercase text-neutral-500">context visible</p>
              <div className="mt-4 space-y-3">
                {contextItems.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3 border-b border-neutral-200 pb-3 last:border-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-neutral-500">{item.label}</div>
                      <div className="truncate text-sm font-medium">{item.value}</div>
                    </div>
                    <span className="hii-state-chip">{item.status}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="hii-panel p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs uppercase text-neutral-500">control board</p>
                <h2 className="mt-2 text-xl font-semibold">Receipts and prepared work</h2>
              </div>
              <AliveBars compact />
            </div>
            <div className="mt-4 min-h-24 space-y-3 font-mono text-xs">
              {spawned.length === 0 ? (
                <div className="hii-receipt-empty">
                  Try `/context`, `/loop`, or `/capabilities`. Prepared tasks, API results, approvals, and proof receipts stay here.
                </div>
              ) : (
                spawned.map((item) => (
                  <div key={item.id} className="hii-receipt">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-semibold">{item.command}</span>
                      {item.href ? (
                        <Link href={item.href} className="underline underline-offset-4">
                          {item.label}
                        </Link>
                      ) : (
                        <span>{item.label}</span>
                      )}
                    </div>
                    {item.lines && (
                      <div className="mt-2 grid gap-1 text-neutral-500">
                        {item.lines.map((line) => (
                          <div key={line} className="flex items-center gap-2">
                            {line === 'loading' && <AliveBars compact />}
                            <span>{line}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="hii-panel p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase text-neutral-500">proof recommender</p>
                <h2 className="mt-2 text-xl font-semibold">Signals that can become receipts</h2>
              </div>
              <span className="hii-state-chip">local scan</span>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {proofRecommendations.map((item) => (
                <article key={item.title} className="hii-photo-rec">
                  <div className="hii-photo-thumb" />
                  <h3 className="mt-3 text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 font-mono text-[11px] text-neutral-400">{item.source}</p>
                  <p className="mt-3 text-sm leading-5 text-neutral-600">{item.idea}</p>
                  <button className="hii-secondary-action mt-4 w-full" type="button">Make receipt</button>
                </article>
              ))}
            </div>
          </section>
        </section>

        <aside className="space-y-4">
          <section className="hii-panel p-5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs uppercase text-neutral-500">agent rail</p>
              <AliveBars compact />
            </div>
            <div className="mt-5 space-y-3">
              {activity.map((item) => (
                <div key={item.text} className="grid grid-cols-[74px_minmax(0,1fr)] gap-3 text-sm">
                  <span className="hii-rail-state">{item.state}</span>
                  <span className="text-neutral-600">{item.text}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="hii-panel p-5">
            <p className="font-mono text-xs uppercase text-neutral-500">system memory</p>
            <div className="mt-4 space-y-3">
              {memoryCards.map((card) => (
                <article key={card.title} className="border border-[rgba(23,107,255,0.24)] bg-white p-4">
                  <h3 className="text-sm font-semibold">{card.title}</h3>
                  <p className="mt-2 text-sm leading-5 text-neutral-600">{card.body}</p>
                  <p className="mt-3 font-mono text-[11px] text-neutral-400">{card.meta}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="hii-panel overflow-hidden p-5">
            <p className="font-mono text-xs uppercase text-neutral-500">control surfaces</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {projectWorlds.map((world) => (
                <div key={world} className="hii-world-tile">
                  {world}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
