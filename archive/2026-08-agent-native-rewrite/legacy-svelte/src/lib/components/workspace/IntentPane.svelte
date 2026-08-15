<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPayload: (payload: Record<string, unknown>) => void = () => {};
  export let onPrepareRun: () => void = () => {};

  let detailsOpen = false;
  $: context = Array.isArray(node.payload.context) ? node.payload.context : [];
</script>

<article class="flex h-full flex-col bg-[#fffdf8] px-5 py-4">
  <textarea
    class="min-h-0 flex-1 resize-none bg-transparent text-[18px] font-medium leading-[1.25] text-neutral-900 outline-none placeholder:text-neutral-300"
    aria-label="Creative intent"
    placeholder="State an idea, question, or direction…"
    value={String(node.payload.text || node.payload.prompt || '')}
    on:input={(event) => onPayload({ text: event.currentTarget.value })}
  ></textarea>

  {#if detailsOpen}
    <section class="mb-2 max-h-20 overflow-auto rounded-xl border border-neutral-900/5 bg-white/70 px-3 py-2 font-mono text-[8px] leading-4 text-neutral-500">
      <p class="uppercase tracking-[0.1em] text-neutral-400">Agent context · {context.length} object{context.length === 1 ? '' : 's'}</p>
      {#if context.length}
        {#each context as item}
          <p class="truncate">{String(item.title || item.type || 'canvas object')}{item.source ? ` · ${String(item.source)}` : ''}</p>
        {/each}
      {:else}
        <p>No canvas objects attached. You can keep this as a thought or prepare a bounded run later.</p>
      {/if}
    </section>
  {/if}

  <footer class="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-400">
    <button class="rounded-full px-2 py-1 hover:bg-neutral-900/5 hover:text-neutral-700" aria-expanded={detailsOpen} on:click={() => detailsOpen = !detailsOpen}>
      {context.length} context
    </button>
    <span class="min-w-0 flex-1 truncate">you · {node.object?.parentId ? 'follow-up' : 'creative intent'}</span>
    <button class="shrink-0 rounded-full bg-neutral-900 px-3 py-1.5 text-white hover:bg-blue-600" on:click={onPrepareRun}>
      Prepare agent run →
    </button>
  </footer>
</article>
