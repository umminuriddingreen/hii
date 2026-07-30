<script lang="ts">
  import { onMount } from 'svelte';
  import type { SpatialObjectStatus, WorkspaceNode } from '@/lib/workspace/types';
  import { workspaceRunBoundaryManifest } from '@/lib/workspace/run-boundary';
  import { terminalRunMessage, workspaceRunEvidence, workspaceRunProgress, type RunProgressStep } from '@/lib/workspace/run-progress';

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
    ledger?: Array<{ actor?: string; type?: string; summary?: string; createdAt?: string }>;
    proofArtifacts?: Array<{ kind?: string; label?: string; path?: string; summary?: string }>;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
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
  type ModelsResponse = {
    models: string[];
    defaultModel: string | null;
    available: boolean;
    message: string;
  };

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
  let modelOptions: string[] = [];
  let selectedModel = String(node.payload.model || '');
  let modelsLoading = false;
  let modelMessage = '';
  let cancellationBusy = false;
  let job: Job | null = node.payload.job as Job || null;
  let evidenceOpen = false;
  let rawEvidenceOpen = false;
  let transientFailure = false;

  $: context = (Array.isArray(node.payload.context) ? node.payload.context : []) as ContextItem[];
  $: boundary = {
    capabilityId: 'hii.agent.workspace_run',
    workspaceRoot: String(node.payload.workspaceRoot || '/Users/ummi/hii'),
    model: selectedModel,
    maxSteps: Number(node.payload.maxSteps || 8),
    network: 'No publish, push, message, spend, or secret export'
  };
  $: boundaryManifest = workspaceRunBoundaryManifest({
    context,
    workspaceRoot: boundary.workspaceRoot
  });
  $: checks = (receipt?.verification || []).filter((check) => check.ok === true);
  $: progressSteps = workspaceRunProgress({
    status,
    contextCount: context.length,
    maxSteps: boundary.maxSteps,
    workspaceRoot: boundary.workspaceRoot,
    job,
    receipt
  }) as RunProgressStep[];
  $: evidence = workspaceRunEvidence(job, receipt);
  $: evidenceCount = evidence.ledger.length + evidence.proofArtifacts.length + evidence.checks.length + evidence.logs.length;

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

  async function loadRun(id: string) {
    try {
      const run = (await apiJson(`/api/workspace/runs?id=${encodeURIComponent(id)}`)) as RunResponse;
      transientFailure = false;
      job = run.job;
      status = run.job.status;
      if (run.receipt) receipt = run.receipt;
      if (run.path) receiptPath = run.path;
    } catch (cause) {
      if (!receipt) error = cause instanceof Error ? cause.message : 'Could not read the managed workspace run.';
    }
  }

  async function poll(id: string) {
    while (active) {
      try {
        const run = (await apiJson(`/api/workspace/runs?id=${encodeURIComponent(id)}`)) as RunResponse;
        job = run.job;
        status = run.job.status;
        if (run.receipt) receipt = run.receipt;
        if (run.path) receiptPath = run.path;
        if (terminalStatuses.has(run.job.status)) {
          const failureError = run.job.status === 'completed'
            ? ''
            : terminalRunMessage(run.job.status);
          const proofRefs = [
            ...(run.job.proofArtifacts || []).map((artifact) => artifact.path || artifact.label || '').filter(Boolean),
            `capability-job:${run.job.id}`
          ];
          patchRun(run.job.status, {
            receipt: run.receipt,
            receiptPath: run.path || '',
            completedAt: new Date().toISOString(),
            resultNodesCreated: run.job.status === 'completed' && Boolean(run.receipt),
            error: failureError,
            progress: workspaceRunProgress({
              status: run.job.status,
              contextCount: context.length,
              maxSteps: boundary.maxSteps,
              workspaceRoot: boundary.workspaceRoot,
              job: run.job,
              receipt: run.receipt
            })
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
    if (busy || !selectedModel || !String(node.payload.prompt || '').trim()) return;
    busy = true;
    transientFailure = false;
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
        model: selectedModel,
        approvedAt: queued.job?.metadata?.approvedAt || new Date().toISOString(),
        boundary: queued.job?.metadata?.boundary || boundary
      });
      await poll(runId);
    } catch (cause) {
      status = 'failed';
      transientFailure = true;
      error = cause instanceof Error ? cause.message : 'Could not start the bounded workspace run.';
      patchRun('failed', { error });
      busy = false;
    }
  }

  async function loadModels() {
    if (modelsLoading) return;
    modelsLoading = true;
    try {
      const result = await apiJson('/api/workspace/runs?mode=models') as ModelsResponse;
      modelOptions = result.models;
      modelMessage = result.message;
      if (!modelOptions.includes(selectedModel)) selectedModel = result.defaultModel || '';
    } catch (cause) {
      modelOptions = [];
      selectedModel = '';
      modelMessage = cause instanceof Error ? cause.message : 'Could not discover installed local models.';
    } finally {
      modelsLoading = false;
    }
  }

  async function requestCancellation() {
    if (cancellationBusy || !['queued', 'running'].includes(status)) return;
    cancellationBusy = true;
    error = '';
    try {
      await apiJson('/api/workspace/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id: runId })
      });
      patchRun(status, { cancelRequestedAt: new Date().toISOString() });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not ask AII to stop the run.';
      cancellationBusy = false;
    }
  }

  function prepareRetry() {
    const prompt = String(node.payload.prompt || '').trim();
    if (prompt) onFollowUp(prompt);
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

  function toggleEvidence() {
    evidenceOpen = !evidenceOpen;
    if (!evidenceOpen) rawEvidenceOpen = false;
  }

  onMount(() => {
    active = true;
    if (runId && ['queued', 'running'].includes(status)) {
      busy = true;
      void poll(runId);
    } else if (runId && terminalStatuses.has(status)) {
      void loadRun(runId);
    }
    if (['waiting_approval', 'proposed'].includes(status)) void loadModels();
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
                  <span class="block break-all font-mono text-[8px] uppercase text-neutral-400">{item.type}{item.source ? ` · ${item.source}` : ' · no source reference'}</span>
                </div>
              {/each}
            </div>
            {#if boundaryManifest.missingProvenanceCount}
              <div class="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">{boundaryManifest.missingProvenanceCount} selected object{boundaryManifest.missingProvenanceCount === 1 ? '' : 's'} {boundaryManifest.missingProvenanceCount === 1 ? 'has' : 'have'} no source reference. The object remains visible, but its provenance is incomplete.</div>
            {/if}
            {#if boundaryManifest.blocked}
              <div class="mt-2 rounded-xl border border-red-300 bg-red-50 p-3 text-[10px] leading-5 text-red-900">Remove secret-like files or credential-bearing URLs before approval. HII will not queue this context.</div>
            {/if}
          {:else}
            <div class="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">No canvas objects were selected. The intent still carries workspace-level read and write authority shown below.</div>
          {/if}
        </div>

        <dl class="mt-5 grid grid-cols-2 gap-2 text-[9px]">
          <div class="rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Capability</dt><dd class="mt-1 break-all text-neutral-700">{boundary.capabilityId}</dd></div>
          <div class="rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Budget</dt><dd class="mt-1 text-neutral-700">{boundary.maxSteps} local tool steps</dd></div>
          <div class="col-span-2 rounded-xl bg-blue-50 p-3"><dt class="font-mono uppercase text-blue-500">Read boundary</dt><dd class="mt-1 leading-4 text-blue-950">{boundaryManifest.readScope}</dd></div>
          <div class="col-span-2 rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Write boundary</dt><dd class="mt-1 break-all text-neutral-700">{boundaryManifest.writeScope}</dd></div>
          <div class="col-span-2 rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">External boundary</dt><dd class="mt-1 text-neutral-700">{boundaryManifest.externalScope}</dd></div>
          <div class="col-span-2 rounded-xl bg-neutral-100 p-3"><dt class="font-mono uppercase text-neutral-400">Secret policy</dt><dd class="mt-1 text-neutral-700">{boundaryManifest.secretPolicy}</dd></div>
        </dl>

        <label class="mt-3 block rounded-xl bg-neutral-100 p-3 font-mono text-[8px] uppercase tracking-[.1em] text-neutral-400">
          Installed local model
          <select class="mt-1.5 w-full bg-transparent text-[10px] normal-case tracking-normal text-neutral-800 outline-none" bind:value={selectedModel} disabled={modelsLoading || modelOptions.length === 0}>
            {#if modelsLoading}<option value="">Discovering installed models…</option>{/if}
            {#each modelOptions as model}<option value={model}>{model}</option>{/each}
            {#if !modelsLoading && modelOptions.length === 0}<option value="">No local model available</option>{/if}
          </select>
          <span class="mt-1.5 block normal-case tracking-normal text-neutral-500">{modelMessage}</span>
        </label>

        <button class="mt-5 w-full rounded-full bg-neutral-950 px-4 py-3 font-mono text-[9px] uppercase tracking-[.1em] text-white disabled:opacity-40" disabled={busy || modelsLoading || !selectedModel || boundaryManifest.blocked} on:click={approveAndStart}>
          {busy ? 'Queueing with AII…' : 'Approve bounded run'}
        </button>
      </section>
    {:else}
      <section class="p-5">
        <div class="space-y-1" aria-label="Run progress">
          {#each progressSteps as step, index}
            <div class="grid grid-cols-[18px_1fr] gap-2.5 rounded-xl px-1 py-2" class:bg-blue-50={step.state === 'current'} class:bg-red-50={step.state === 'attention'}>
              <div class="relative flex justify-center">
                {#if index < progressSteps.length - 1}<span class="absolute left-1/2 top-4 h-[calc(100%+5px)] w-px -translate-x-1/2 bg-neutral-200"></span>{/if}
                <span class="relative z-10 grid h-4 w-4 place-items-center rounded-full border font-mono text-[8px]"
                  class:border-emerald-500={step.state === 'done'}
                  class:bg-[var(--hii-acid-green)]={step.state === 'done'}
                  class:text-neutral-950={step.state === 'done'}
                  class:border-[var(--hii-electric-blue)]={step.state === 'current'}
                  class:bg-[var(--hii-electric-blue)]={step.state === 'current'}
                  class:text-white={step.state === 'current'}
                  class:border-red-400={step.state === 'attention'}
                  class:bg-red-100={step.state === 'attention'}
                  class:text-red-700={step.state === 'attention'}
                  class:border-neutral-200={step.state === 'pending'}
                  class:bg-white={step.state === 'pending'}
                  class:text-neutral-300={step.state === 'pending'}>
                  {step.state === 'done' ? '✓' : step.state === 'attention' ? '!' : index + 1}
                </span>
              </div>
              <div class="min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <strong class="text-[11px] text-neutral-800">{step.label}</strong>
                  <span class="font-mono text-[7px] uppercase tracking-[.08em]" class:text-blue-600={step.state === 'current'} class:text-red-600={step.state === 'attention'} class:text-neutral-300={step.state === 'pending'} class:text-emerald-700={step.state === 'done'}>{step.state}</span>
                </div>
                <p class="mt-0.5 text-[9px] leading-4 text-neutral-500">{step.detail}</p>
              </div>
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
        {:else if status === 'cancelled'}
          <div class="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">{transientFailure && error ? error : terminalRunMessage(status)}</div>
          <button class="mt-4 w-full rounded-full border border-neutral-900/15 bg-white px-4 py-2.5 font-mono text-[9px] uppercase tracking-[.1em] text-neutral-800" on:click={prepareRetry}>Prepare fresh retry for approval</button>
        {:else if status === 'failed'}
          <div class="mt-6 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] leading-5 text-red-800">{transientFailure && error ? error : terminalRunMessage(status)}</div>
          <button class="mt-4 w-full rounded-full border border-neutral-900/15 bg-white px-4 py-2.5 font-mono text-[9px] uppercase tracking-[.1em] text-neutral-800" on:click={prepareRetry}>Prepare fresh retry for approval</button>
        {:else if error}
          <div class="mt-6 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] leading-5 text-red-800">{error}</div>
        {:else}
          <div class="mt-10 text-center">
            <span class="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--hii-electric-blue)]"></span>
            <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400">{status === 'queued' ? 'AII accepted the approved intent' : 'bounded local work in progress'}</p>
            <p class="mx-auto mt-2 max-w-[38ch] text-[10px] leading-5 text-neutral-400">Raw logs remain available as proof; this view shows the governed state.</p>
            <button class="mt-5 rounded-full border border-neutral-900/15 bg-white px-4 py-2 font-mono text-[8px] uppercase tracking-[.1em] text-neutral-700 disabled:opacity-40" disabled={cancellationBusy} on:click={requestCancellation}>
              {cancellationBusy ? 'Stop requested from AII…' : 'Stop bounded run'}
            </button>
          </div>
        {/if}

        {#if job || receipt}
          <button class="mt-5 flex w-full items-center justify-between rounded-xl border border-neutral-900/10 bg-white px-3 py-2.5 text-left" aria-expanded={evidenceOpen} on:pointerdown|stopPropagation on:click|stopPropagation={toggleEvidence}>
            <span>
              <strong class="block text-[10px] text-neutral-800">Inspect evidence</strong>
              <span class="font-mono text-[7px] uppercase tracking-[.08em] text-neutral-400">{evidenceCount} records · raw output stays nested</span>
            </span>
            <span class="font-mono text-[10px] text-neutral-400">{evidenceOpen ? '−' : '+'}</span>
          </button>
          {#if evidenceOpen}
            <section class="mt-2 rounded-xl border border-neutral-900/10 bg-white p-3" aria-label="Run evidence">
              <div class="grid grid-cols-3 gap-1.5 text-center font-mono text-[7px] uppercase tracking-[.06em] text-neutral-400">
                <div class="rounded-lg bg-neutral-50 p-2"><strong class="block text-[13px] text-neutral-800">{evidence.passingChecks}</strong>passing</div>
                <div class="rounded-lg bg-neutral-50 p-2"><strong class="block text-[13px] text-neutral-800">{evidence.proofArtifacts.length}</strong>proof</div>
                <div class="rounded-lg bg-neutral-50 p-2"><strong class="block text-[13px] text-neutral-800">{evidence.duration || '—'}</strong>duration</div>
              </div>

              {#if evidence.checks.length}
                <div class="mt-3">
                  <h3 class="font-mono text-[7px] uppercase tracking-[.1em] text-neutral-400">Verification</h3>
                  <div class="mt-1.5 space-y-1">
                    {#each evidence.checks as check}
                      <div class="flex gap-2 rounded-lg px-2 py-1.5 text-[9px]" class:bg-emerald-50={check.ok === true} class:bg-red-50={check.ok === false}>
                        <span class={check.ok === true ? 'text-emerald-700' : 'text-red-700'}>{check.ok === true ? '✓' : '!'}</span>
                        <span class="min-w-0 break-all text-neutral-700">{check.command || 'verification check'}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if evidence.proofArtifacts.length}
                <div class="mt-3">
                  <h3 class="font-mono text-[7px] uppercase tracking-[.1em] text-neutral-400">Proof returned</h3>
                  <div class="mt-1.5 space-y-1">
                    {#each evidence.proofArtifacts as artifact}
                      <div class="rounded-lg bg-neutral-50 px-2 py-1.5">
                        <strong class="block text-[9px] text-neutral-700">{artifact.label || artifact.kind || 'proof record'}</strong>
                        {#if artifact.path}<span class="block truncate font-mono text-[7px] text-neutral-400">{artifact.path}</span>{/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if evidence.ledger.length}
                <div class="mt-3">
                  <h3 class="font-mono text-[7px] uppercase tracking-[.1em] text-neutral-400">Decision trail</h3>
                  <div class="mt-1.5 space-y-1">
                    {#each evidence.ledger as entry}
                      <p class="rounded-lg bg-neutral-50 px-2 py-1.5 text-[9px] leading-4 text-neutral-600">{entry.summary || entry.type || 'governed event'}</p>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if evidence.logs.length}
                <button class="mt-3 flex w-full items-center justify-between border-t border-neutral-900/10 pt-3 font-mono text-[8px] uppercase tracking-[.08em] text-neutral-500" aria-expanded={rawEvidenceOpen} on:pointerdown|stopPropagation on:click|stopPropagation={()=>rawEvidenceOpen=!rawEvidenceOpen}>
                  <span>Raw execution log · {evidence.logs.length}</span>
                  <span>{rawEvidenceOpen ? 'hide' : 'show'}</span>
                </button>
                {#if rawEvidenceOpen}
                  <pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-950 p-3 font-mono text-[8px] leading-4 text-neutral-300">{evidence.logs.join('\n\n')}</pre>
                {/if}
              {/if}
            </section>
          {/if}
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
