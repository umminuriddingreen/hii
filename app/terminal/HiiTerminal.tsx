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

type CapabilityDefinition = {
  id: string;
  name: string;
  owner: string;
  runtime: string;
  summary: string;
  visibility: string;
  status: string;
  trustLevel: string;
  costModel: { type: string; currency?: string };
};

type CapabilityJob = {
  id: string;
  capabilityId: string;
  inputSummary: string;
  status: string;
  budget?: string;
  createdAt: string;
  ledger?: unknown[];
  proofArtifacts?: unknown[];
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
    '$ hii console --stream matrix --agents',
    'connecting to local context stream...'
  ]);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [preset, setPreset] = useState('observer');
  const [name, setName] = useState('hii-observer');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityDefinition[]>([]);
  const [jobs, setJobs] = useState<CapabilityJob[]>([]);
  const terminalRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    async function loadCapabilities() {
      const [capabilityRes, jobRes] = await Promise.all([
        fetch('/api/capabilities', { cache: 'no-store' }),
        fetch('/api/capabilities/jobs', { cache: 'no-store' })
      ]);
      if (capabilityRes.ok) {
        const data = await capabilityRes.json();
        setCapabilities(data.capabilities ?? []);
      }
      if (jobRes.ok) {
        const data = await jobRes.json();
        setJobs(data.jobs ?? []);
      }
    }
    void loadCapabilities();
  }, []);

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
      const jobsRes = await fetch('/api/capabilities/jobs', { cache: 'no-store' });
      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        setJobs(jobsData.jobs ?? []);
      }
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
    <div className="hii-page">
      <section className="hii-page-header">
        <p className="hii-kicker">HII console</p>
        <h1 className="hii-page-title">
          Matrix view for system and agent work.
        </h1>
        <p className="hii-page-copy">
          A local-only power layer for watching Claude/Codex-style turns, agent sessions,
          HII jobs, workstation activity, approvals, and proof receipts as one transcript.
        </p>
      </section>

      <section className="grid gap-5 pt-6 lg:grid-cols-[minmax(18rem,22rem)_1fr]">
        <aside className="space-y-5">
          <div className="hii-card">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Stream</h2>
              <span
                className={`border px-2 py-1 text-xs uppercase ${
                  connected
                    ? 'border-[var(--hii-electric-blue)] bg-[var(--hii-soft-green)] text-[var(--hii-graphite)]'
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
              onClick={() => setLines(['$ hii console --clear'])}
              className="hii-secondary-action mt-4 w-full"
            >
              Clear console
            </button>
          </div>

          <div className="hii-card">
            <h2 className="font-semibold">Capability Registry</h2>
            <div className="mt-3 space-y-3 text-sm">
              {capabilities.length === 0 && <p className="text-neutral-500">Loading backend capabilities...</p>}
              {capabilities.map((capability) => (
                <div key={capability.id} className="border-t border-neutral-100 pt-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{capability.name}</p>
                      <p className="mt-1 font-mono text-xs text-neutral-500">{capability.id}</p>
                    </div>
                    <span className="border border-[rgba(23,107,255,0.28)] bg-[var(--hii-warm-white)] px-2 py-1 text-xs uppercase text-neutral-600">
                      {capability.status}
                    </span>
                  </div>
                  <p className="mt-2 text-neutral-600">{capability.summary}</p>
                  <p className="mt-2 text-xs text-neutral-500">
                    {capability.runtime} · {capability.visibility} · {capability.trustLevel}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="hii-card">
            <h2 className="font-semibold">Capability Jobs</h2>
            <div className="mt-3 space-y-2 text-sm text-neutral-700">
              {jobs.length === 0 && <p>No local capability jobs yet.</p>}
              {jobs.slice(0, 5).map((job) => (
                <div key={job.id} className="border-t border-neutral-100 pt-2">
                  <p className="font-mono text-xs">{job.capabilityId}</p>
                  <p className="mt-1 text-neutral-600">{job.inputSummary}</p>
                  <p className="mt-1 text-xs uppercase text-neutral-500">
                    {job.status} · {new Date(job.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    ledger {job.ledger?.length ?? 0} · proof {job.proofArtifacts?.length ?? 0}
                  </p>
                </div>
              ))}
            </div>
            <a
              href="/credits"
              className="hii-secondary-action mt-4 block text-center"
            >
              Quote a task
            </a>
          </div>

          <div className="hii-card">
            <h2 className="font-semibold">Spawn Agent Session</h2>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-sm text-neutral-600">Preset</span>
                <select
                  value={preset}
                  onChange={(event) => setPreset(event.target.value)}
                  className="hii-select mt-1 w-full px-3 py-2"
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
                  className="hii-field mt-1 w-full px-3 py-2"
                />
              </label>
              <label className="block">
                <span className="text-sm text-neutral-600">Prompt</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="hii-textarea mt-1 min-h-32 w-full px-3 py-2 text-sm"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="button"
                onClick={spawnAgent}
                disabled={spawning}
                className="hii-command-button w-full disabled:opacity-50"
              >
                {spawning ? 'Spawning...' : 'Spawn Claude session'}
              </button>
            </div>
          </div>

          <div className="hii-card">
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

        <div className="hii-terminal-frame min-w-0">
          <div className="hii-terminal-bar">
            <span>hii://console/matrix</span>
            <span>{showAll ? 'all processes' : 'agent focus'}</span>
          </div>
          <pre
            ref={terminalRef}
            className="hii-terminal-body h-[calc(100vh-13rem)] overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed"
          >
            {lines.join('\n')}
          </pre>
        </div>
      </section>
    </div>
  );
}
