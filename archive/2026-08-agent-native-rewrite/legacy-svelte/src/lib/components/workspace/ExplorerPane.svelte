<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';
  import BrowserPane from './BrowserPane.svelte';
  import TerminalPane from '../TerminalPane.svelte';

  export let node: WorkspaceNode;
  export let onPayload: (patch: Record<string, unknown>) => void;

  let command = '';
  $: sessionId = String(node.payload.sessionId || '');
  $: currentUrl = String(node.payload.url || '');
  $: browserNode = { ...node, type: 'browser' as const };

  function shellQuote(value: string) {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  function runInTerminal(value: string) {
    const next = value.trim();
    if (!next || !sessionId) return;
    window.dispatchEvent(new CustomEvent('hii:terminal-command', {
      detail: { sessionId, command: next }
    }));
    command = '';
  }

  function requestCurrentPage() {
    if (!/^https?:\/\//i.test(currentUrl)) return;
    runInTerminal(`curl -I -L --max-time 20 -- ${shellQuote(currentUrl)}`);
  }
</script>

<div class="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(220px,0.72fr)] bg-white lg:grid-cols-[minmax(0,1.28fr)_minmax(360px,0.72fr)] lg:grid-rows-1">
  <section class="min-h-0 border-b border-neutral-900/10 lg:border-b-0 lg:border-r">
    <BrowserPane node={browserNode} {onPayload} />
  </section>
  <section class="flex min-h-0 flex-col bg-white">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b px-2">
      <span class="font-mono text-[9px] uppercase tracking-[0.14em] text-neutral-400">live shell</span>
      <button
        class="rounded-full border px-2 py-1 font-mono text-[9px] text-neutral-500 disabled:opacity-30"
        disabled={!/^https?:\/\//i.test(currentUrl)}
        on:click={requestCurrentPage}
        title="Send a bounded HEAD request for the current page to the terminal"
      >request page ↘</button>
      <input
        bind:value={command}
        class="min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none"
        placeholder="run an explicit shell command…"
        on:keydown={(event)=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();runInTerminal(command)}}}
      />
      <button
        class="rounded-full bg-neutral-950 px-2.5 py-1 font-mono text-[9px] text-white disabled:opacity-30"
        disabled={!command.trim()}
        on:click={()=>runInTerminal(command)}
      >run</button>
    </div>
    <div class="min-h-0 flex-1">
      <TerminalPane {sessionId} cwd={String(node.payload.cwd || '')} />
    </div>
  </section>
</div>
