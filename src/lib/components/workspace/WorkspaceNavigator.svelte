<script lang="ts">
  import { workspaceFlattenOutlineEntries, workspaceOutlineEntryCount, workspaceOutlineGroups } from '@/lib/workspace/outline';
  import { workspaceNodeTitle } from '@/lib/workspace/search';
  import { workspaceSceneTypeSummary } from '@/lib/workspace/scenes';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let nodes: WorkspaceNode[];
  export let currentSceneId: string | null = null;
  export let onClose: () => void;
  export let onCreateScene: () => void;
  export let onOpenScene: (node: WorkspaceNode) => void;
  export let onFocusNode: (node: WorkspaceNode) => void;
  export let onAdjacentScene: (direction: -1 | 1) => void;

  let query = '';
  let expanded = new Set<string>();
  $: groups = workspaceOutlineGroups(nodes, query);
  $: scenes = groups.filter((group) => group.scene);
  $: totalSceneCount = nodes.filter((node) => node.type === 'frame').length;
  $: visibleObjects = groups.reduce((count, group) => count + workspaceOutlineEntryCount(group.entries), 0);

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function groupOpen(id: string) {
    return query.trim().length > 0 || expanded.has(id) || id === currentSceneId;
  }

  function statusTone(status: string) {
    if (['completed', 'verified', 'ready'].includes(status)) return 'bg-emerald-50 text-emerald-700';
    if (['failed', 'blocked', 'cancelled'].includes(status)) return 'bg-red-50 text-red-700';
    if (['running', 'queued', 'proposed', 'waiting approval'].includes(status)) return 'bg-blue-50 text-blue-700';
    return 'bg-neutral-100 text-neutral-500';
  }

  function status(node: WorkspaceNode) {
    const value = node.payload.status ?? node.object?.status;
    return typeof value === 'string' ? value.replaceAll('_', ' ') : '';
  }
</script>

<section class="absolute bottom-12 left-0 flex max-h-[min(620px,calc(100vh-120px))] w-[min(390px,calc(100vw-40px))] flex-col overflow-hidden rounded-2xl border border-neutral-900/10 bg-white p-2 shadow-2xl" aria-label="Workspace map">
  <div class="flex items-center justify-between px-3 py-2">
    <div>
      <p class="font-mono text-[9px] uppercase tracking-[.12em] text-neutral-400">Workspace outline</p>
      <p class="mt-1 text-[12px] text-neutral-600">{nodes.length} objects · {totalSceneCount} scenes · {visibleObjects} shown</p>
    </div>
    <button class="rounded-full bg-neutral-100 px-2 py-1 font-mono text-[9px] uppercase text-neutral-500" on:click={onClose}>Close</button>
  </div>

  <label class="mx-3 mb-2 block">
    <span class="sr-only">Search workspace outline</span>
    <input bind:value={query} type="search" aria-label="Search workspace outline" placeholder="Find an intent, run, receipt, or object…" class="w-full rounded-xl border border-neutral-900/10 bg-neutral-50 px-3 py-2 text-[12px] outline-none focus:border-blue-400 focus:bg-white" />
  </label>

  {#if scenes.length}
    <div class="flex items-center justify-between border-b px-3 pb-2">
      <p class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Named scenes</p>
      <div class="flex gap-1">
        <button class="rounded-full bg-neutral-100 px-2 py-1 text-[10px]" aria-label="Previous scene" on:click={() => onAdjacentScene(-1)}>←</button>
        <button class="rounded-full bg-neutral-100 px-2 py-1 text-[10px]" aria-label="Next scene" on:click={() => onAdjacentScene(1)}>→</button>
      </div>
    </div>
  {/if}

  <div class="scroll min-h-0 flex-1 overflow-auto py-1">
    {#if groups.length}
      {#each groups as group}
        <section class="my-1 overflow-hidden rounded-xl border border-neutral-900/[.07]" class:bg-blue-50={group.id === currentSceneId}>
          <div class="flex items-center gap-1 p-1">
            <button class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/80" aria-label={`Toggle ${group.title} objects`} aria-expanded={groupOpen(group.id)} on:click={() => toggle(group.id)}>
              <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-50 font-mono text-[9px] text-blue-700">{group.sequence ?? '·'}</span>
              <span class="min-w-0 flex-1">
                <strong class="block truncate text-[13px]">{group.title}</strong>
                <small class="block truncate font-mono text-[8px] uppercase text-neutral-400">{group.scene ? workspaceSceneTypeSummary(nodes.filter((node) => node.frameId === group.id)) : `${group.memberCount} unframed objects`}</small>
              </span>
              <span class="font-mono text-[9px] text-neutral-400">{group.memberCount}</span>
              <span class="text-neutral-400">{groupOpen(group.id) ? '−' : '+'}</span>
            </button>
            {#if group.scene}
              <button class="rounded-lg px-2 py-2 font-mono text-[9px] uppercase text-blue-600 hover:bg-white" aria-label={`Open scene ${group.title}`} on:click={() => onOpenScene(group.scene!)}>Go</button>
            {/if}
          </div>
          {#if group.statusCounts.length}
            <div class="flex flex-wrap gap-1 px-3 pb-2">
              {#each group.statusCounts.slice(0, 4) as [label, count]}
                <span class={`rounded-full px-2 py-1 font-mono text-[7px] uppercase ${statusTone(label)}`}>{count} {label}</span>
              {/each}
            </div>
          {/if}
          {#if groupOpen(group.id)}
            <div class="border-t border-neutral-900/[.06] bg-white/70 py-1">
              {#each workspaceFlattenOutlineEntries(group.entries) as entry}
                <button class="flex w-full items-center gap-2 py-2 pr-3 text-left hover:bg-blue-50" style={`padding-left:${12 + entry.depth * 16}px`} on:click={() => onFocusNode(entry.node)}>
                  <span class="font-mono text-[9px] text-neutral-300">{entry.depth ? '└' : '•'}</span>
                  <span class="min-w-0 flex-1">
                    <strong class="block truncate text-[11px]">{workspaceNodeTitle(entry.node)}</strong>
                    <small class="font-mono text-[7px] uppercase text-neutral-400">{entry.node.object?.kind || entry.node.type}</small>
                  </span>
                  {#if status(entry.node)}
                    <span class={`max-w-24 truncate rounded-full px-2 py-1 font-mono text-[7px] uppercase ${statusTone(status(entry.node))}`}>{status(entry.node)}</span>
                  {/if}
                  <span class="text-blue-600">⌖</span>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    {:else}
      <div class="mx-1 rounded-xl bg-neutral-50 p-3">
        <p class="text-[12px] leading-5 text-neutral-500">{query.trim() ? 'No workspace object matches this search.' : 'Scenes name related objects and keep a large workspace navigable.'}</p>
        {#if !query.trim()}<button class="mt-3 font-mono text-[9px] uppercase text-blue-600 underline" on:click={onCreateScene}>Create a scene</button>{/if}
      </div>
    {/if}
  </div>
</section>
