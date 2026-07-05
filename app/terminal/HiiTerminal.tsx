'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type ProcessLine = {
  pid: string;
  user: string;
  cpu: string;
  mem: string;
  command: string;
  raw: string;
  agent: boolean;
};

type AgentSession = {
  id?: string;
  pid?: number;
  name?: string;
  cwd?: string;
  kind?: string;
  state?: string;
  status?: string;
  waitingFor?: string;
  sessionId?: string;
};

type TerminalSnapshot = {
  capturedAt: string;
  host: string;
  processCount: number;
  agentCount: number;
  agents: AgentSession[];
  processes: ProcessLine[];
};

const defaultPrompt =
  'Observe HII, AII, Termite, Codex, Claude, Ollama, and local dev server activity. Report stuck agents, blocked permission prompts, failed builds, and next actions.';

function formatAgent(agent: AgentSession) {
  const label = agent.name || agent.id || agent.sessionId || `pid:${agent.pid ?? 'unknown'}`;
  const state = agent.state || agent.status || 'unknown';
  const wait = agent.waitingFor ? ` waiting:${agent.waitingFor}` : '';
  return `${label} ${state}${wait}`;
}

function snapshotToLines(snapshot: TerminalSnapshot, showAll: boolean) {
  const time = new Date(snapshot.capturedAt).toLocaleTimeString();
  const selectedProcesses = showAll
    ? snapshot.processes
    : snapshot.processes.filter((process) => process.agent);

  return [
    '',
    `--- ${time} ${snapshot.host} processes:${snapshot.processCount} agents:${snapshot.agentCount} mode:${showAll ? 'all' : 'agent-focus'} ---`,
    ...snapshot.agents.map((agent) => `[agent] ${formatAgent(agent)}`),
    ...selectedProcesses.map((process) => `${process.agent ? '[agent-process]' : '[process]'} ${process.raw}`)
  ];
}

export function HiiTerminal() {
  const [connected, setConnected] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [lines, setLines] = useState<string[]>([
    '$ hii terminal --stream system --agents',
    'connecting to local process stream...'
  ]);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [preset, setPreset] = useState('observer');
  const [name, setName] = useState('hii-observer');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminalRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/terminal/stream');

    source.addEventListener('open', () => {
      setConnected(true);
    });

    source.addEventListener('snapshot', (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data) as TerminalSnapshot;
      setAgents(snapshot.agents);
      setLines((current) => {
        const next = [...current, ...snapshotToLines(snapshot, showAll)];
        return next.slice(Math.max(0, next.length - 1800));
      });
    });

    source.addEventListener('error', (event) => {
      setConnected(false);
      const message = (event as MessageEvent).data || 'stream disconnected';
      setLines((current) => [...current, `[stream-error] ${message}`].slice(-1800));
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, [showAll]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [lines]);

  async function spawnAgent() {
    setSpawning(true);
    setError(null);
    try {
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset, prompt, name })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to spawn agent.');
      setLines((current) =>
        [
          ...current,
          '',
          `--- spawned ${data.run.name}${data.run.id ? ` (${data.run.id})` : ''} ---`,
          data.run.output || 'spawn request accepted'
        ].slice(-1800)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn agent.';
      setError(message);
      setLines((current) => [...current, `[spawn-error] ${message}`].slice(-1800));
    } finally {
      setSpawning(false);
    }
  }

  const agentRows = useMemo(() => agents.slice(0, 12), [agents]);

  return (
    <div className="min-h-[calc(100vh-9rem)]">
      <section className="border-b border-neutral-200 pb-6">
        <p className="text-sm font-medium text-neutral-500">HII terminal</p>
        <h1 className="mt-3 text-3xl font-bold tracking-normal">
          Live conversation stream for system and agent work.
        </h1>
        <p className="mt-4 max-w-3xl text-neutral-600">
          A local-only browser terminal for watching Claude/Codex-style turns, agent sessions,
          HII jobs, workstation activity, approvals, and future ledger events as one transcript.
        </p>
      </section>

      <section className="grid gap-5 pt-6 lg:grid-cols-[minmax(18rem,22rem)_1fr]">
        <aside className="space-y-5">
          <div className="rounded border border-neutral-200 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Stream</h2>
              <span
                className={`rounded border px-2 py-1 text-xs uppercase ${
                  connected
                    ? 'border-green-700 text-green-700'
                    : 'border-neutral-300 text-neutral-500'
                }`}
              >
                {connected ? 'live' : 'offline'}
              </span>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
              />
              Show all system processes
            </label>
            <button
              type="button"
              onClick={() => setLines(['$ hii terminal --clear'])}
              className="mt-4 w-full rounded border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              Clear terminal
            </button>
          </div>

          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Task Ledger</h2>
            <div className="mt-3 space-y-2 text-sm text-neutral-700">
              <p>Each approved task should reserve credits before running.</p>
              <p>Completed work appends compute reimbursement, HII fee, proof, and receipt rows.</p>
            </div>
            <a
              href="/credits"
              className="mt-4 block rounded border border-neutral-300 px-3 py-2 text-center text-sm font-medium hover:bg-neutral-50"
            >
              Quote a task
            </a>
          </div>

          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Spawn Agent Session</h2>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-sm text-neutral-600">Preset</span>
                <select
                  value={preset}
                  onChange={(event) => setPreset(event.target.value)}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
                >
                  <option value="observer">Read-only observer</option>
                  <option value="termite-demo">Termite demo operator</option>
                  <option value="shipper">HII shipper</option>
                  <option value="custom">Custom bounded prompt</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-neutral-600">Session name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
                />
              </label>
              <label className="block">
                <span className="text-sm text-neutral-600">Prompt</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="mt-1 min-h-32 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="button"
                onClick={spawnAgent}
                disabled={spawning}
                className="w-full rounded bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                {spawning ? 'Spawning...' : 'Spawn Claude terminal'}
              </button>
            </div>
          </div>

          <div className="rounded border border-neutral-200 p-4">
            <h2 className="font-semibold">Agent Sessions</h2>
            <div className="mt-3 space-y-2 text-sm">
              {agentRows.length === 0 && <p className="text-neutral-500">No Claude sessions reported.</p>}
              {agentRows.map((agent) => (
                <div key={agent.id || agent.sessionId || agent.pid} className="border-t border-neutral-100 pt-2">
                  <p className="font-mono text-xs">{agent.name || agent.id || agent.sessionId}</p>
                  <p className="text-neutral-600">
                    {agent.state || agent.status || 'unknown'}
                    {agent.waitingFor ? ` · ${agent.waitingFor}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <div className="min-w-0 rounded border border-neutral-900 bg-black">
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3 font-mono text-xs text-neutral-400">
            <span>hii://terminal/system</span>
            <span>{showAll ? 'all processes' : 'agent focus'}</span>
          </div>
          <pre
            ref={terminalRef}
            className="h-[calc(100vh-13rem)] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-green-200"
          >
            {lines.join('\n')}
          </pre>
        </div>
      </section>
    </div>
  );
}
