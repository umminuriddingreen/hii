<script lang="ts">
  import { onMount } from 'svelte';
  import type { SpatialObjectStatus, WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPatch: (patch: Partial<WorkspaceNode>) => void;
  export let onFollowUp: (text: string) => void;

  type RunResponse = {
    id: string;
    status: string;
    visibleOutput?: string;
    outputBytes?: number;
    log?: string;
    completedAt?: string;
    exitCode?: number | null;
  };

  const terminalStatuses = new Set(['completed', 'failed', 'stopped']);
  let active = true;
  let busy = false;
  let runId = String(node.payload.runId || node.object?.runId || '');
  let status = String(node.payload.status || node.object?.status || 'queued');
  let output = String(node.payload.output || '');
  let outputBytes = Number(node.payload.outputBytes || 0);
  let error = '';
  let followUp = '';

  function objectStatus(value: string): SpatialObjectStatus {
    if (value === 'stopped') return 'archived';
    if (['queued', 'running', 'failed', 'completed'].includes(value)) return value as SpatialObjectStatus;
    return 'unknown';
  }

  function patchRun(nextStatus: string, payload: Record<string, unknown> = {}, proofRefs?: string[]) {
    const now = new Date().toISOString();
    onPatch({
      object: {
        ...node.object,
        kind: 'run',
        owner: 'aii',
        status: objectStatus(nextStatus),
        runId: runId || undefined,
        proofRefs: proofRefs || node.object?.proofRefs,
        audit: [
          ...(node.object?.audit || []),
          {
            ts: now,
            actor: 'hii' as const,
            action: `managed agent run ${nextStatus}`
          }
        ].slice(-20)
      },
      payload: {
        ...node.payload,
        autoStart: false,
        runId,
        status: nextStatus,
        ...payload
      }
    });
  }

  async function daemonJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'HII daemon request failed.');
    return body;
  }

  async function poll(id: string) {
    while (active) {
      try {
        const run = (await daemonJson(`/api/daemon/runs/${encodeURIComponent(id)}`)) as RunResponse;
        status = run.status;
        outputBytes = Number(run.outputBytes || 0);
        if (run.visibleOutput) output = run.visibleOutput;
        if (terminalStatuses.has(run.status)) {
          const finalOutput = run.visibleOutput || (run.status === 'completed' ? 'Run completed without a text response.' : '');
          output = finalOutput;
          const proofRefs = [run.log, `daemon-run:${run.id}`].filter((value): value is string => Boolean(value));
          patchRun(run.status, {
            output: finalOutput,
            outputBytes,
            completedAt: run.completedAt || new Date().toISOString(),
            exitCode: run.exitCode ?? null,
            log: run.log || ''
          }, proofRefs);
          busy = false;
          return;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Could not read the managed run.';
        busy = false;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 850));
    }
  }

  async function start() {
    if (busy) return;
    const intent = String(node.payload.prompt || '').trim();
    if (!intent) {
      status = 'failed';
      error = 'This run has no approved intent.';
      patchRun('failed', { error });
      return;
    }
    busy = true;
    error = '';
    status = 'queued';
    output = '';
    try {
      const daemon = await daemonJson('/api/daemon');
      if (!daemon.alive) {
        await daemonJson('/api/daemon', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'start' })
        });
      }
      const prompt = [
        'You are responding directly on the local HII spatial workspace.',
        'Return a useful spatial artifact: lead with the outcome, then make context, decisions, actions, and proof explicit when relevant.',
        'Do not publish, push, spend, message, delete, expose secrets, or take another irreversible or external action without separate explicit authority.',
        `User intent:\n${intent}`
      ].join('\n\n');
      const queued = await daemonJson('/api/daemon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'codex.run', prompt })
      });
      runId = String(queued.result?.runId || '');
      if (!runId) throw new Error('HII did not return a managed run id.');
      patchRun('queued', { runId, queuedAt: new Date().toISOString() });
      await poll(runId);
    } catch (cause) {
      status = 'failed';
      error = cause instanceof Error ? cause.message : 'Could not start the managed HII run.';
      patchRun('failed', { error });
      busy = false;
    }
  }

  async function stop() {
    if (!runId || terminalStatuses.has(status)) return;
    try {
      await daemonJson('/api/daemon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'codex.stop', id: runId })
      });
      status = 'stopped';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not stop the managed run.';
    }
  }

  function branch() {
    const text = followUp.trim();
    if (!text) return;
    onFollowUp(text);
    followUp = '';
  }

  onMount(() => {
    active = true;
    if (node.payload.autoStart && !runId) void start();
    else if (runId && !terminalStatuses.has(status)) {
      busy = true;
      void poll(runId);
    }
    return () => {
      active = false;
    };
  });
</script>

<article class="flex h-full min-h-0 flex-col bg-[#fbfbfa]">
  <header class="flex shrink-0 items-center justify-between border-b border-neutral-900/10 px-4 py-2.5">
    <div class="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-500">
      <i class={`h-2 w-2 rounded-full ${status === 'queued' || status === 'running' ? 'animate-pulse bg-[var(--hii-electric-blue)]' : status === 'completed' ? 'bg-[var(--hii-acid-green)]' : status === 'failed' ? 'bg-red-500' : 'bg-neutral-400'}`}></i>
      <span>{status}</span>
      {#if outputBytes > 0}<span class="text-neutral-300">{Math.ceil(outputBytes / 1024)} KB proof</span>{/if}
    </div>
    {#if runId && !terminalStatuses.has(status)}
      <button class="font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400 hover:text-red-600" on:click={stop}>stop</button>
    {/if}
  </header>

  <div class="scroll min-h-0 flex-1 overflow-auto px-5 py-4">
    {#if output}
      <pre class="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-neutral-800">{output}{#if !terminalStatuses.has(status)}<span class="ml-0.5 inline-block h-[1em] w-1 animate-pulse bg-[var(--hii-electric-blue)] align-[-0.1em]"></span>{/if}</pre>
    {:else if error}
      <div class="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">{error}</div>
    {:else}
      <div class="flex h-full min-h-32 items-center justify-center text-center">
        <div>
          <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--hii-electric-blue)]"></span>
          <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400">{status === 'queued' ? 'waiting for HII runtime' : 'agent is working'}</p>
        </div>
      </div>
    {/if}
  </div>

  {#if terminalStatuses.has(status)}
    <footer class="shrink-0 border-t bg-white p-3">
      <div class="flex gap-2">
        <textarea bind:value={followUp} rows="2" class="min-h-[46px] flex-1 resize-none bg-transparent text-xs outline-none" placeholder="Branch a follow-up from this result…" on:keydown={(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();branch()}}}></textarea>
        <button class="self-end rounded-full bg-neutral-950 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-white disabled:opacity-30" disabled={!followUp.trim()} on:click={branch}>branch ↵</button>
      </div>
      <div class="mt-2 flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.1em] text-neutral-400">
        <span>{runId || 'no run id'}</span>
        {#if status === 'failed'}<button class="text-neutral-700" on:click={start}>retry</button>{/if}
      </div>
    </footer>
  {/if}
</article>
