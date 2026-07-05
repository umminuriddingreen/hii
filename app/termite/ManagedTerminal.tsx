'use client';

import { useEffect, useMemo, useState } from 'react';

type TermiteJob = {
  id: string;
  capabilityId: string;
  inputSummary: string;
  workflow: string;
  prompt: string;
  budget: string;
  status: 'queued';
  createdAt: string;
  logs: string[];
  proofArtifacts?: Array<{
    id: string;
    kind: string;
    label: string;
    summary?: string;
  }>;
};

const workflowLabels: Record<string, string> = {
  'rhino-smoke-test': 'Rhino smoke test',
  'geometry-check': 'Geometry check',
  'viewport-proof': 'Viewport proof',
  'export-readiness': 'Export readiness',
  'custom-managed-run': 'Custom managed run'
};

export function ManagedTerminal({ signedIn }: { signedIn: boolean }) {
  const [workflow, setWorkflow] = useState('rhino-smoke-test');
  const [budget, setBudget] = useState('alpha-free');
  const [prompt, setPrompt] = useState('Run a Termite alpha smoke test: connect to Rhino, inspect document state, create safe test geometry, capture a viewport proof, and report blockers.');
  const [jobs, setJobs] = useState<TermiteJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshJobs() {
    if (!signedIn) return;
    const res = await fetch('/api/termite/jobs', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setJobs(data.jobs ?? []);
  }

  useEffect(() => {
    void refreshJobs();
  }, [signedIn]);

  async function launchJob() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/termite/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow, prompt, budget })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Launch failed.');
      setJobs((current) => [data.job, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed.');
    } finally {
      setBusy(false);
    }
  }

  const terminalLines = useMemo(() => {
    const latest = jobs[0];
    if (!signedIn) {
      return [
        '$ hii termite launch',
        'status: account required',
        'action: sign in to create a managed Termite job'
      ];
    }
    if (!latest) {
      return [
        '$ hii termite launch --managed',
        'status: ready',
        'select a workflow, describe the Rhino task, then launch a managed job'
      ];
    }
    return [
      `$ hii termite job ${latest.id.slice(0, 8)}`,
      `capability: ${latest.capabilityId}`,
      `status: ${latest.status}`,
      `workflow: ${workflowLabels[latest.workflow] ?? latest.workflow}`,
      `budget: ${latest.budget}`,
      ...latest.logs
    ];
  }, [jobs, signedIn]);

  return (
    <section className="border-t border-neutral-200 pt-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Managed Job Terminal</h2>
          <p className="mt-2 text-sm text-neutral-600">
            A client account can launch a managed Termite job. You run the Rhino/Codex workflow
            on your system, monitor it, then upload proof or deliverables back through HII.
          </p>
        </div>
        {!signedIn && (
          <a href="/login?next=/termite" className="rounded bg-black px-4 py-2 text-sm font-medium text-white">
            Sign in
          </a>
        )}
      </div>

      <div className="mt-5 rounded border border-neutral-800 bg-black p-4 font-mono text-sm text-green-200">
        {terminalLines.map((line) => (
          <p key={line} className="break-words">
            {line}
          </p>
        ))}
      </div>

      <div className="mt-5 grid gap-4">
        <label className="block">
          <span className="text-sm text-neutral-600">Workflow</span>
          <select
            value={workflow}
            onChange={(event) => setWorkflow(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
            disabled={!signedIn}
          >
            {Object.entries(workflowLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-neutral-600">Budget</span>
          <select
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2"
            disabled={!signedIn}
          >
            <option value="alpha-free">Alpha feedback run</option>
            <option value="pilot-paid">Paid pilot</option>
            <option value="monthly-managed">Monthly managed workflow</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-neutral-600">Rhino task</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="mt-1 min-h-36 w-full rounded border border-neutral-300 bg-white px-3 py-2"
            disabled={!signedIn}
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="button"
          onClick={launchJob}
          disabled={!signedIn || busy}
          className="rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? 'Launching...' : 'Launch managed job'}
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="mt-8">
          <h3 className="font-semibold">Recent managed jobs</h3>
          <div className="mt-3 space-y-3">
            {jobs.slice(0, 5).map((job) => (
              <div key={job.id} className="rounded border border-neutral-200 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-mono">{job.id}</span>
                  <span className="rounded border border-neutral-300 px-2 py-1 text-xs uppercase">
                    {job.status}
                  </span>
                </div>
                <p className="mt-2 text-neutral-600">{workflowLabels[job.workflow] ?? job.workflow}</p>
                <p className="mt-1 font-mono text-xs text-neutral-500">{job.capabilityId}</p>
                {job.proofArtifacts && job.proofArtifacts.length > 0 && (
                  <p className="mt-2 text-xs text-neutral-500">
                    proof: {job.proofArtifacts.map((artifact) => artifact.label).join(', ')}
                  </p>
                )}
                <p className="mt-1 text-xs text-neutral-400">{new Date(job.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
