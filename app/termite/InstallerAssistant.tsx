'use client';

import { useEffect, useState } from 'react';

type InstallerState = {
  checkedAt: string;
  termiteRoot: string;
  alphaZip: boolean;
  stagedRelease: boolean;
  rhinoApp: boolean;
  rhinoPlugin: boolean;
};

type InstallerAction = {
  id: string;
  label: string;
  description: string;
};

type InstallerRun = {
  actionId: string;
  command: string;
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
};

type Guidance = {
  text: string;
  model: string;
  available: boolean;
};

type InstallerResponse = {
  state: InstallerState;
  actions: InstallerAction[];
  guidance: Guidance;
  run?: InstallerRun;
};

const stateLabels: Array<[keyof InstallerState, string]> = [
  ['alphaZip', 'HII alpha zip exists'],
  ['stagedRelease', 'Termite release staged'],
  ['rhinoApp', 'Rhino 8 installed'],
  ['rhinoPlugin', 'Termite Rhino bridge installed']
];

export function InstallerAssistant() {
  const [state, setState] = useState<InstallerState | null>(null);
  const [actions, setActions] = useState<InstallerAction[]>([]);
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [run, setRun] = useState<InstallerRun | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const res = await fetch('/api/termite/installer', { cache: 'no-store' });
    const data = (await res.json()) as InstallerResponse | { error?: string };
    if (!res.ok) {
      setError('Installer status failed.');
      return;
    }
    const payload = data as InstallerResponse;
    setState(payload.state);
    setActions(payload.actions);
    setGuidance(payload.guidance);
  }

  async function runAction(actionId: string) {
    setBusyAction(actionId);
    setError(null);
    try {
      const res = await fetch('/api/termite/installer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId })
      });
      const data = (await res.json()) as InstallerResponse | { error?: string };
      if (!res.ok) throw new Error('error' in data ? data.error : 'Installer action failed.');
      const payload = data as InstallerResponse;
      setState(payload.state);
      setGuidance(payload.guidance);
      setRun(payload.run ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Installer action failed.');
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className="border-t border-[var(--hii-electric-blue)] pt-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Local LLM Install Manager</h2>
          <p className="mt-2 text-sm text-neutral-600">
            HII checks the local Termite/Rhino install, asks the local model for the next
            provisionable step, and runs only whitelisted install scripts from this browser.
            The same action log can become the update path for a client machine or worker.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="hii-secondary-action"
        >
          Refresh
        </button>
      </div>

      {state && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {stateLabels.map(([key, label]) => (
            <div key={key} className="hii-stat-card">
              <div className="text-xs uppercase text-neutral-500">{label}</div>
              <div className="mt-1 font-mono text-sm">{state[key] ? 'PASS' : 'MISSING'}</div>
            </div>
          ))}
        </div>
      )}

      <div className="hii-terminal-frame mt-5 p-4 font-mono text-sm">
        <p>$ local-llm installer-manager</p>
        <p>model: {guidance?.model ?? 'checking...'}</p>
        <p>available: {guidance ? String(guidance.available) : 'checking...'}</p>
        <p>next: {guidance?.text ?? 'Loading local installer guidance...'}</p>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 grid gap-3">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => runAction(action.id)}
            disabled={Boolean(busyAction)}
            className="hii-card text-left hover:bg-[var(--hii-soft-blue)] disabled:opacity-50"
          >
            <span className="block font-medium">
              {busyAction === action.id ? 'Running...' : action.label}
            </span>
            <span className="mt-1 block text-sm text-neutral-500">{action.description}</span>
          </button>
        ))}
      </div>

      {run && (
        <div className="hii-card mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-xs">{run.command}</p>
            <span className="border border-[rgba(23,107,255,0.28)] bg-[var(--hii-warm-white)] px-2 py-1 text-xs uppercase">
              exit {run.exitCode}
            </span>
          </div>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-neutral-700">
            {run.output || '(no output)'}
          </pre>
        </div>
      )}
    </section>
  );
}
