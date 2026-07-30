<script lang="ts">
  import { onMount } from 'svelte';
  import type { SpatialObjectStatus, WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPatch: (patch: Partial<WorkspaceNode>) => void;

  type Skill = {
    id: string; name: string; description: string; status: 'draft' | 'registered';
    permissions: string[]; sideEffects: string[]; verification: string[];
    sourceReceiptIds: string[]; observations: number; reviewedBy: string | null;
    registeredAt: string | null; path: string;
  };
  type Replay = {
    id: string; daemonRunId: string | null; status: string; durationMs: number | null;
    outputBytes: number; receiptId: string | null; checkCount: number; proofCount: number;
    verified: boolean;
  };
  type Comparison = {
    statusChanged: boolean; outcomeChanged: boolean; verificationChanged: boolean;
    durationDeltaMs: number | null; outputBytesDelta: number;
    checkCountDelta: number; proofCountDelta: number;
  };
  type Detail = { skill: Skill; replays: Replay[]; comparison: Comparison | null };

  const terminal = new Set(['completed', 'failed', 'cancelled', 'stopped']);
  let active = true;
  let detail: Detail | null = null;
  let loading = false;
  let busy = false;
  let error = '';
  let reviewedBy = '';
  let currentReplayId = '';

  $: skillId = String(node.payload.skillId || node.object?.capabilityId || '');
  $: skill = detail?.skill || null;
  $: latest = detail?.replays?.[0] || null;
  $: comparison = detail?.comparison || null;

  function formatDuration(value: number | null) {
    if (value === null) return 'pending';
    return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  }
  function signed(value: number, suffix = '') { return `${value > 0 ? '+' : ''}${value}${suffix}`; }
  function replayObjectStatus(status: string): SpatialObjectStatus {
    return ['queued', 'running'].includes(status) ? 'running' : 'ready';
  }
  async function apiJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'HII capability request failed.');
    return body;
  }
  async function loadDetail() {
    if (!skillId) return;
    loading = true;
    try {
      detail = await apiJson(`/api/skills?id=${encodeURIComponent(skillId)}`) as Detail;
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read this HII capability.';
    } finally { loading = false; }
  }
  async function registerDraft() {
    if (busy || !reviewedBy.trim() || skill?.status !== 'draft') return;
    busy = true; error = '';
    try {
      const result = await apiJson('/api/skills', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'register', id: skillId, reviewedBy: reviewedBy.trim(), approved: true })
      });
      detail = { skill: result.skill as Skill, replays: [], comparison: null };
      const now = new Date().toISOString();
      onPatch({
        object: {
          ...node.object, kind: 'capability', status: 'ready', owner: 'aii',
          audit: [...(node.object?.audit || []), {
            ts: now, actor: 'human' as const, action: 'reviewed and registered capability', note: reviewedBy.trim()
          }].slice(-20)
        },
        payload: {
          ...node.payload, skillStatus: 'registered', reviewedBy: reviewedBy.trim(),
          registeredAt: result.skill.registeredAt
        }
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not register this HII capability.';
    } finally { busy = false; }
  }
  async function pollReplay() {
    while (active && currentReplayId) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        const next = await apiJson(`/api/skills?id=${encodeURIComponent(skillId)}`) as Detail;
        detail = next;
        const replay = next.replays.find((item) => item.id === currentReplayId);
        if (replay && terminal.has(replay.status)) {
          onPatch({
            object: { ...node.object, kind: 'capability', status: replayObjectStatus(replay.status) },
            payload: {
              ...node.payload, lastReplayId: replay.id, lastReplayRunId: replay.daemonRunId,
              lastReplayStatus: replay.status, lastReplayVerified: replay.verified
            }
          });
          busy = false;
          return;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Could not read the capability replay.';
        busy = false;
        return;
      }
    }
  }
  async function approveReplay() {
    if (busy || skill?.status !== 'registered') return;
    busy = true; error = '';
    try {
      const result = await apiJson('/api/skills', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'replay', id: skillId, approved: true })
      });
      currentReplayId = String(result.replay?.id || '');
      onPatch({
        object: { ...node.object, kind: 'capability', status: 'running' },
        payload: {
          ...node.payload, lastReplayId: currentReplayId,
          lastReplayRunId: String(result.runId || ''), lastReplayStatus: 'queued'
        }
      });
      await loadDetail();
      void pollReplay();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not start the capability replay.';
      busy = false;
    }
  }
  onMount(() => {
    active = true; void loadDetail();
    return () => { active = false; };
  });
</script>

<article class="flex h-full min-h-0 flex-col overflow-hidden bg-white">
  <header class="flex shrink-0 items-center justify-between border-b border-neutral-900/10 px-4 py-3">
    <div class="min-w-0">
      <p class="font-mono text-[8px] uppercase tracking-[.14em] text-neutral-400">reusable capability</p>
      <h2 class="mt-1 truncate text-[14px] font-semibold text-neutral-950">{skill?.name || String(node.payload.title || skillId)}</h2>
    </div>
    <span class="rounded-full px-2 py-1 font-mono text-[8px] uppercase tracking-[.08em]"
      class:bg-emerald-100={skill?.status === 'registered'} class:text-emerald-800={skill?.status === 'registered'}
      class:bg-amber-100={skill?.status !== 'registered'} class:text-amber-800={skill?.status !== 'registered'}>
      {loading ? 'reading' : skill?.status || 'draft'}
    </span>
  </header>

  <div class="scroll min-h-0 flex-1 overflow-auto p-4">
    <p class="text-[12px] leading-5 text-neutral-700">{skill?.description || String(node.payload.summary || 'Proof-backed HII capability.')}</p>

    {#if skill}
      <div class="mt-4 grid grid-cols-2 gap-2 text-[9px]">
        <div class="rounded-xl bg-neutral-100 p-3"><span class="font-mono uppercase text-neutral-400">Observations</span><strong class="mt-1 block text-[14px] text-neutral-800">{skill.observations}</strong></div>
        <div class="rounded-xl bg-neutral-100 p-3"><span class="font-mono uppercase text-neutral-400">Source receipts</span><strong class="mt-1 block text-[14px] text-neutral-800">{skill.sourceReceiptIds.length}</strong></div>
      </div>

      <section class="mt-4 space-y-2" aria-label="Capability execution boundary">
        <div class="rounded-xl bg-blue-50 p-3">
          <h3 class="font-mono text-[8px] uppercase tracking-[.1em] text-blue-600">Permissions</h3>
          {#each skill.permissions as item}<p class="mt-1 text-[10px] leading-4 text-blue-950">• {item}</p>{/each}
          {#if !skill.permissions.length}<p class="mt-1 text-[10px] text-blue-950">No additional permissions declared.</p>{/if}
        </div>
        <div class="rounded-xl bg-amber-50 p-3">
          <h3 class="font-mono text-[8px] uppercase tracking-[.1em] text-amber-700">Side effects</h3>
          {#each skill.sideEffects as item}<p class="mt-1 text-[10px] leading-4 text-amber-950">• {item}</p>{/each}
          {#if !skill.sideEffects.length}<p class="mt-1 text-[10px] text-amber-950">No side effects declared.</p>{/if}
        </div>
        <div class="rounded-xl bg-emerald-50 p-3">
          <h3 class="font-mono text-[8px] uppercase tracking-[.1em] text-emerald-700">Required proof</h3>
          {#each skill.verification as item}<p class="mt-1 text-[10px] leading-4 text-emerald-950">• {item}</p>{/each}
          {#if !skill.verification.length}<p class="mt-1 text-[10px] text-emerald-950">A verified source receipt is required.</p>{/if}
        </div>
      </section>

      {#if skill.status === 'draft'}
        <div class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <strong class="block font-mono text-[9px] uppercase tracking-[.1em] text-amber-900">Operator review required</strong>
          <p class="mt-1 text-[10px] leading-5 text-amber-800">Registration grants repeat execution authority only within the manifest above. Inspect every field before registering.</p>
        </div>
        <input bind:value={reviewedBy} class="mt-3 w-full rounded-xl border border-neutral-900/10 bg-neutral-50 px-3 py-2 text-[11px] outline-none focus:border-blue-400" placeholder="Reviewer name" aria-label="Capability reviewer name" />
        <button class="mt-2 w-full rounded-full bg-neutral-950 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[.1em] text-white disabled:opacity-30" disabled={busy || !reviewedBy.trim()} on:click={registerDraft}>
          {busy ? 'Registering reviewed capability…' : 'I reviewed this · register'}
        </button>
      {:else}
        <div class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-5 text-emerald-900">
          Registered by <strong>{skill.reviewedBy || 'operator'}</strong>. Every replay creates a new managed run and must return a fresh receipt before HII treats it as comparable.
        </div>
        <button class="mt-3 w-full rounded-full bg-[var(--hii-electric-blue)] px-4 py-2.5 font-mono text-[9px] uppercase tracking-[.1em] text-white disabled:opacity-30" disabled={busy} on:click={approveReplay}>
          {busy ? 'Replay in progress…' : 'Approve registered replay'}
        </button>

        {#if latest}
          <section class="mt-4 rounded-xl border border-neutral-900/10 bg-neutral-50 p-3" aria-label="Latest capability replay">
            <div class="flex items-center justify-between">
              <h3 class="font-mono text-[8px] uppercase tracking-[.1em] text-neutral-500">Latest replay</h3>
              <span class="font-mono text-[8px] uppercase" class:text-emerald-700={latest.verified} class:text-amber-700={!latest.verified}>{latest.verified ? 'verified' : latest.status}</span>
            </div>
            <div class="mt-3 grid grid-cols-3 gap-1.5 text-center">
              <div class="rounded-lg bg-white p-2"><strong class="block text-[12px] text-neutral-800">{formatDuration(latest.durationMs)}</strong><span class="font-mono text-[7px] uppercase text-neutral-400">duration</span></div>
              <div class="rounded-lg bg-white p-2"><strong class="block text-[12px] text-neutral-800">{latest.checkCount}</strong><span class="font-mono text-[7px] uppercase text-neutral-400">checks</span></div>
              <div class="rounded-lg bg-white p-2"><strong class="block text-[12px] text-neutral-800">{latest.proofCount}</strong><span class="font-mono text-[7px] uppercase text-neutral-400">proof</span></div>
            </div>
            {#if !latest.receiptId}<p class="mt-2 text-[9px] leading-4 text-amber-800">Receipt pending. HII will not call this replay verified or use it as a trusted baseline yet.</p>{/if}
          </section>
        {:else}
          <p class="mt-4 rounded-xl bg-neutral-100 p-3 text-[10px] leading-5 text-neutral-600">No replay baseline yet. The first approved replay establishes one only after its receipt arrives.</p>
        {/if}

        {#if comparison && latest}
          <section class="mt-2 rounded-xl border border-blue-200 bg-blue-50 p-3" aria-label="Capability replay comparison">
            <h3 class="font-mono text-[8px] uppercase tracking-[.1em] text-blue-600">Compared with previous replay</h3>
            <dl class="mt-2 grid grid-cols-2 gap-2 text-[9px]">
              <div><dt class="text-blue-700/70">Duration</dt><dd class="font-mono text-blue-950">{comparison.durationDeltaMs === null ? 'pending' : signed(comparison.durationDeltaMs, ' ms')}</dd></div>
              <div><dt class="text-blue-700/70">Output</dt><dd class="font-mono text-blue-950">{signed(comparison.outputBytesDelta, ' B')}</dd></div>
              <div><dt class="text-blue-700/70">Checks</dt><dd class="font-mono text-blue-950">{signed(comparison.checkCountDelta)}</dd></div>
              <div><dt class="text-blue-700/70">Proof</dt><dd class="font-mono text-blue-950">{signed(comparison.proofCountDelta)}</dd></div>
            </dl>
            {#if comparison.statusChanged || comparison.outcomeChanged || comparison.verificationChanged}<p class="mt-2 text-[9px] leading-4 text-blue-900">Status, outcome, or verification changed. Inspect both receipts before trusting the replay.</p>{/if}
          </section>
        {/if}
      {/if}
    {:else if !loading}
      <div class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-[10px] leading-5 text-red-800">This workspace object has no readable HII skill manifest. It cannot be registered or replayed.</div>
    {/if}

    {#if error}<p class="mt-3 rounded-xl bg-red-50 p-3 text-[10px] leading-5 text-red-800">{error}</p>{/if}
    {#if skill?.path}<p class="mt-4 break-all font-mono text-[8px] leading-4 text-neutral-400">{skill.path}</p>{/if}
  </div>
  <footer class="shrink-0 border-t px-4 py-2 font-mono text-[8px] uppercase tracking-[.1em] text-neutral-400">AII registry · receipt-gated replay</footer>
</article>
