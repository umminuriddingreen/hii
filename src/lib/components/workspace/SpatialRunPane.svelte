<script lang="ts">
  import { onMount } from 'svelte';
  import type { SpatialObjectStatus, WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPatch: (patch: Partial<WorkspaceNode>) => void;
  export let onFollowUp: (text: string) => void;
  export let onComplete: (result: Record<string, unknown>) => void;
  export let onCapabilityDraft: (result: Record<string, unknown>) => void;

  type ContextItem = { id: string; title: string; type: string; source?: string };
  type Job = {
    id: string;
    status: string;
    logs?: string[];
    proofArtifacts?: Array<{ kind?: string; label?: string; path?: string; summary?: string }>;
    metadata?: Record<string, unknown>;
  };
  type ReceiptCheck = { command?: string; ok?: boolean; output?: string };
  type Receipt = {
    id?: string;
    summary?: string;
    status?: string;
    verification?: ReceiptCheck[];
    artifacts?: string[];
  };
  type RunResponse = { job: Job; path?: string | null; receipt?: Receipt | null };

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  let active = true;
  let busy = false;
  let runId = String(node.payload.runId || node.object?.runId || node.id);
  let status = String(node.payload.status || node.object?.status || 'waiting_approval');
  let error = String(node.payload.error || '');
  let followUp = '';
  let receipt: Receipt | null = node.payload.receipt as Receipt || null;
  let receiptPath = String(node.payload.receiptPath || '');
  let capabilityBusy = false;
  let capabilityId = String(node.payload.skillDraftId || '');
  let capabilityError = '';
  let completedEmitted = Boolean(node.payload.resultNodesCreated);

  $: context = (Array.isArray(node.payload.context) ? node.payload.context : []) as ContextItem[];
  $: boundary = {
    capabilityId: 'hii.agent.workspace_run',
    workspaceRoot: String(node.payload.workspaceRoot || '/Users/ummi/hii'),
    model: String(node.payload.model || 'qwen3.6:35b-mlx'),
    maxSteps: Number(node.payload.maxSteps || 8),
    network: 'No publish, push, message, spend, or secret export'
  };
  $: checks = (receipt?.verification || []).filter((check) => check.ok === true);
  $: currentStep = status === 'waiting_approval' || status === 'proposed'
    ? 0
    : status === 'queued'
      ? 1
      : status === 'running'
        ? 2
        : status === 'completed'
          ? 4
          : status === 'failed' || status === 'cancelled'
            ? 2
            : 3;

  function objectStatus(value: string): SpatialObjectStatus {
    if (value === 'cancelled') return 'archived';
    if (['proposed', 'queued', 'running', 'waiting_approval', 'failed', 'completed'].includes(value)) {
      return value as SpatialObjectStatus;
    }
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
            actor: nextStatus === 'waiting_approval' ? 'human' as const : 'hii' as const,
            action: nextStatus === 'waiting_approval'
              ? 'reviewing bounded workspace run'
              : `managed workspace run ${nextStatus}`
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

  async function apiJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'HII workspace run request failed.');
    return body;
  }

  function emitComplete(run: RunResponse) {
    if (completedEmitted || !run.receipt) return;
    completedEmitted = true;
    onComplete({
      nodeId: node.id,
      runId,
      status: run.job.status,
      intent: String(node.payload.prompt || ''),
      context,
      boundary,
      receipt: run.receipt,
      receiptPath: run.path || '',
      job: run.job
    });
  }

  async function poll(id: string) {
    while (active) {
      try {
        const run = (await apiJson(`/api/workspace/runs?id=${encodeURIComponent(id)}`)) as RunResponse;
        status = run.job.status;
        if (run.receipt) receipt = run.receipt;
        if (run.path) receiptPath = run.path;
        if (terminalStatuses.has(run.job.status)) {
          const failureError = run.job.status === 'completed'
            ? ''
            : run.job.logs?.at(-1) || 'The bounded run did not complete.';
          const proofRefs = [
            ...(run.job.proofArtifacts || []).map((artifact) => artifact.path || artifact.label || '').filter(Boolean),
            `capability-job:${run.job.id}`
          ];
          patchRun(run.job.status, {
            receipt: run.receipt,
            receiptPath: run.path || '',
            completedAt: new Date().toISOString(),
            resultNodesCreated: run.job.status === 'completed' && Boolean(run.receipt),
            error: failureError
          }, proofRefs);
          if (run.job.status === 'completed') emitComplete(run);
          else error = failureError;
          busy = false;
          return;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Could not read the managed workspace run.';
        busy = false;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function approveAndStart() {
    if (busy || !String(node.payload.prompt || '').trim()) return;
    busy = true;
    error = '';
    status = 'queued';
    try {
      const daemon = await apiJson('/api/daemon');
      if (!daemon.alive) {
        await apiJson('/api/daemon', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'start' })
        });
      }
      const queued = await apiJson('/api/workspace/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          id: runId,
          projectId: 'hii-spatial-workspace',
          goal: String(node.payload.prompt || ''),
          context,
          workspaceRoot: boundary.workspaceRoot,
          model: boundary.model,
          maxSteps: boundary.maxSteps,
          approved: true
        })
      });
      runId = String(queued.job?.id || runId);
      patchRun('queued', {
        runId,
        approvedAt: queued.job?.metadata?.approvedAt || new Date().toISOString(),
        boundary: queued.job?.metadata?.boundary || boundary
      });
      await poll(runId);
    } catch (cause) {
      status = 'failed';
      error = cause instanceof Error ? cause.message : 'Could not start the bounded workspace run.';
      patchRun('failed', { error });
      busy = false;
    }
  }

  async function createCapabilityDraft() {
    if (capabilityBusy || capabilityId || status !== 'completed') return;
    capabilityBusy = true;
    capabilityError = '';
    try {
      const result = await apiJson('/api/workspace/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'draft-capability',
          id: runId,
          name: String(node.payload.title || node.payload.prompt || 'Verified workspace run')
        })
      });
      capabilityId = String(result.draft?.id || '');
      const bundle = String(result.draft?.bundle || '');
      patchRun('completed', { skillDraftId: capabilityId, skillDraftBundle: bundle });
      onCapabilityDraft({
        nodeId: node.id,
        runId,
        id: capabilityId,
        bundle,
        title: String(node.payload.title || 'Verified workspace capability'),
        receiptPath
      });
    } catch (cause) {
      capabilityError = cause instanceof Error ? cause.message : 'Could not create the capability draft.';
    } finally {
      capabilityBusy = false;
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
    if (runId && ['queued', 'running'].includes(status)) {
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
      <i class={`h-2 w-2 rounded-full ${status === 'queued' || status === 'running' ? 'animate-pulse bg-[var(--hii-electric-blue)]' : status === 'completed' ? 'bg-[var(--hii-acid-green)]' : status === 'failed' ? 'bg-red-500' : 'bg-amber-400'}`}></i>
      <span>{status === 'waiting_approval' ? 'needs your approval' : status}</span>
    </div>
    <span class="font-mono text-[8px] uppercase tracking-[.1em] text-neutral-300">AII · bounded run</span>
  </header>

  <div class="scroll min-h-0 flex-1 overflow-auto">
    {#if status === 'waiting_approval' || status === 'proposed'}
      <section class="p-5">
        <p class="font-mono text-[8px] uppercase tracking-[.14em] text-[var(--hii-electric-blue)]">Review before execution</p>
        <h2 class="mt-2 text-[19px] font-semibold leading-tight text-neutral-950">{String(node.payload.prompt || 'Untitled intent')}</h2>

        <div class="mt-5">
          <div class="flex items-center justify-between">
            <h3 class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Approved canvas context</h3>
            <span class="font-mono text-[8px] text-neutral-400">{context.length} object{context.length === 1 ? '' : 's'}</span>
          </div>
          {#if context.length}
            <div class="mt-2 space-y-1.5">
              {#each context as item}
                <div class="rounded-xl border border-neutral-900/10 bg-white px-3 py-2">
                  <strong class="block truncate text-[11px] text-neutral-800">{item.title}</strong>
                  <span class="font-mono text-[8px] uppercase text-neutral-400">{item.type}{item.source ? ` · ${item.source}` : ''}</span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">No canvas objects were selected. AII will receive only this intent and the approved project boundary.</div>
          {/if}
        </div>

        <dl class="mt-5 grid grid-cols-2 gap-2 text-[9px]">
          <div class="rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Capability</dt><dd class="mt-1 break-all text-neutral-700">{boundary.capabilityId}</dd></div>
          <div class="rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Budget</dt><dd class="mt-1 text-neutral-700">{boundary.maxSteps} local tool steps</dd></div>
          <div class="col-span-2 rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Write boundary</dt><dd class="mt-1 break-all text-neutral-700">{boundary.workspaceRoot}</dd></div>
          <div class="col-span-2 rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">External boundary</dt><dd class="mt-1 text-neutral-700">{boundary.network}</dd></div>
        </dl>

        <button class="mt-5 w-full rounded-full bg-neutral-950 px-4 py-3 font-mono text-[9px] uppercase tracking-[.1em] text-white disabled:opacity-40" disabled={busy} on:click={approveAndStart}>
          {busy ? 'Queueing with AII…' : 'Approve bounded run'}
        </button>
      </section>
    {:else}
      <section class="p-5">
        <div class="grid grid-cols-5 gap-1.5" aria-label="Run progress">
          {#each ['approved', 'queued', 'working', 'proof', 'receipt'] as step, index}
            <div>
              <div class="h-1.5 rounded-full" class:bg-[var(--hii-electric-blue)]={index <= currentStep} class:bg-neutral-200={index > currentStep}></div>
              <span class="mt-1 block truncate font-mono text-[7px] uppercase text-neutral-400">{step}</span>
            </div>
          {/each}
        </div>

        {#if status === 'completed' && receipt}
          <div class="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <p class="font-mono text-[8px] uppercase tracking-[.12em] text-emerald-700">Verified receipt returned</p>
            <p class="mt-2 text-[13px] leading-6 text-emerald-950">{receipt.summary || 'The bounded workspace run completed.'}</p>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <span class="rounded-full bg-white px-2 py-1 font-mono text-[8px] text-emerald-800">{checks.length} passing check{checks.length === 1 ? '' : 's'}</span>
              <span class="rounded-full bg-white px-2 py-1 font-mono text-[8px] text-emerald-800">{receipt.artifacts?.length || 0} changed artifact{receipt.artifacts?.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          {#if capabilityId}
            <div class="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[10px] text-amber-900">Draft <strong>{capabilityId}</strong> created. Operator review is still required.</div>
          {:else}
            <button class="mt-4 w-full rounded-full border border-neutral-900/15 bg-white px-4 py-2.5 font-mono text-[9px] uppercase tracking-[.1em] text-neutral-800 disabled:opacity-40" disabled={capabilityBusy || checks.length === 0} on:click={createCapabilityDraft}>
              {capabilityBusy ? 'Creating proof-backed draft…' : 'Save verified run as capability draft'}
            </button>
          {/if}
          {#if capabilityError}<p class="mt-2 text-[10px] leading-5 text-red-700">{capabilityError}</p>{/if}
        {:else if error}
          <div class="mt-6 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] leading-5 text-red-800">{error}</div>
        {:else}
          <div class="mt-10 text-center">
            <span class="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--hii-electric-blue)]"></span>
            <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400">{status === 'queued' ? 'AII accepted the approved intent' : 'bounded local work in progress'}</p>
            <p class="mx-auto mt-2 max-w-[38ch] text-[10px] leading-5 text-neutral-400">Raw logs remain available as proof; this view shows the governed state.</p>
          </div>
        {/if}
      </section>
    {/if}
  </div>

  {#if terminalStatuses.has(status)}
    <footer class="shrink-0 border-t bg-white p-3">
      <div class="flex gap-2">
        <textarea bind:value={followUp} rows="2" class="min-h-[46px] flex-1 resize-none bg-transparent text-xs outline-none" placeholder={receipt ? 'Branch a follow-up from this receipt…' : 'Branch a revised intent from this run…'} on:keydown={(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();branch()}}}></textarea>
        <button class="self-end rounded-full bg-neutral-950 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-white disabled:opacity-30" disabled={!followUp.trim()} on:click={branch}>branch ↵</button>
      </div>
      <div class="mt-2 flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.1em] text-neutral-400">
        <span>{runId}</span>
        {#if receiptPath}<span>receipt saved</span>{/if}
      </div>
    </footer>
  {/if}
</article>
