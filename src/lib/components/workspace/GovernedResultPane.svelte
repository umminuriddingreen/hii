<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;

  const value = (key: string) => String(node.payload[key] ?? '');
  const items = (key: string) => Array.isArray(node.payload[key]) ? node.payload[key] as Array<Record<string, unknown>> : [];
</script>

<article class="flex h-full min-h-0 flex-col overflow-hidden bg-white">
  <header class="flex shrink-0 items-center justify-between border-b border-neutral-900/10 px-4 py-3">
    <div>
      <p class="font-mono text-[8px] uppercase tracking-[.14em] text-neutral-400">{node.object?.kind}</p>
      <h2 class="mt-1 max-w-[34ch] truncate text-[14px] font-semibold text-neutral-950">{value('title') || node.object?.kind}</h2>
    </div>
    <span class="rounded-full px-2 py-1 font-mono text-[8px] uppercase tracking-[.08em]"
      class:bg-emerald-100={node.object?.status === 'completed' || node.object?.status === 'ready'}
      class:text-emerald-800={node.object?.status === 'completed' || node.object?.status === 'ready'}
      class:bg-amber-100={node.object?.status === 'proposed'}
      class:text-amber-800={node.object?.status === 'proposed'}>
      {node.object?.status || 'unknown'}
    </span>
  </header>

  <div class="scroll min-h-0 flex-1 overflow-auto p-4">
    {#if node.object?.kind === 'artifact'}
      <p class="whitespace-pre-wrap text-[13px] leading-6 text-neutral-700">{value('summary') || value('content')}</p>
      {#if value('path')}<p class="mt-4 break-all rounded-xl bg-neutral-100 p-3 font-mono text-[9px] leading-5 text-neutral-600">{value('path')}</p>{/if}
    {:else if node.object?.kind === 'receipt'}
      <p class="text-[12px] leading-5 text-neutral-700">{value('summary')}</p>
      <dl class="mt-4 grid gap-3 text-[11px]">
        <div><dt class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Intent</dt><dd class="mt-1">{value('intent')}</dd></div>
        <div><dt class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Approved context</dt><dd class="mt-1">{items('context').length} object{items('context').length === 1 ? '' : 's'}</dd></div>
        <div><dt class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Verification</dt><dd class="mt-1">{items('checks').length} passing check{items('checks').length === 1 ? '' : 's'}</dd></div>
      </dl>
      {#if items('checks').length}<div class="mt-4 space-y-2">{#each items('checks') as check}<div class="rounded-xl bg-emerald-50 p-2.5 text-[10px] text-emerald-900"><span class="mr-2">✓</span>{String(check.command || 'verified')}</div>{/each}</div>{/if}
      {#if value('receiptPath')}<p class="mt-4 break-all font-mono text-[8px] leading-4 text-neutral-400">{value('receiptPath')}</p>{/if}
    {:else if node.object?.kind === 'capability'}
      <p class="text-[13px] leading-6 text-neutral-700">{value('summary')}</p>
      <div class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
        <strong class="block font-mono text-[9px] uppercase tracking-[.1em] text-amber-900">Operator review required</strong>
        <p class="mt-1 text-[10px] leading-5 text-amber-800">This is a proof-backed draft. It cannot execute until it is explicitly reviewed and registered.</p>
      </div>
      {#if value('bundle')}<p class="mt-4 break-all font-mono text-[8px] leading-4 text-neutral-400">{value('bundle')}</p>{/if}
    {/if}
  </div>

  <footer class="shrink-0 border-t px-4 py-2 font-mono text-[8px] uppercase tracking-[.1em] text-neutral-400">
    {node.object?.owner || 'hii'} · {node.object?.runId || 'local object'}
  </footer>
</article>
