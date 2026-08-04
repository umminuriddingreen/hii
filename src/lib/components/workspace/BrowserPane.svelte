<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPayload: (patch: Record<string, unknown>) => void;

  type BrowserCommand =
    | { type: 'navigate'; url: string }
    | { type: 'back' | 'forward' | 'reload' }
    | { type: 'click'; x: number; y: number }
    | { type: 'type'; text: string }
    | { type: 'key'; key: string }
    | { type: 'scroll'; deltaY: number };

  type Snapshot = { image: string; title: string; url: string; text: string; width: number; height: number };

  const sessionId = `workspace-${node.id}`;
  let prompt = '';
  let snapshot: Snapshot | null = null;
  let viewport: HTMLButtonElement;
  let working = false;
  let message = 'Starting HII Chromium…';
  let poll: ReturnType<typeof setInterval> | null = null;

  const normalize = (value: string) => /^https?:\/\//i.test(value)
    ? value
    : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)
      ? `https://${value}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;

  async function send(command: BrowserCommand) {
    working = true;
    message = command.type === 'navigate' ? 'Opening…' : 'Working…';
    try {
      const response = await fetch('/api/browser/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sessionId, command })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chromium command failed');
      snapshot = data;
      message = '';
      onPayload({ url: data.url, title: data.title || new URL(data.url).hostname, browserEngine: 'chromium-headless' });
    } catch (error) {
      message = error instanceof Error ? error.message : 'Chromium command failed';
    } finally {
      working = false;
    }
  }

  async function refresh() {
    if (working || !snapshot) return;
    try {
      const response = await fetch(`/api/browser/session?id=${encodeURIComponent(sessionId)}`);
      if (response.ok) snapshot = await response.json();
    } catch { /* the next command will surface connection errors */ }
  }

  function runPrompt() {
    const value = prompt.trim();
    if (!value) return;
    prompt = '';
    if (value === '/back') return void send({ type: 'back' });
    if (value === '/forward') return void send({ type: 'forward' });
    if (value === '/reload') return void send({ type: 'reload' });
    if (value.startsWith('/type ')) return void send({ type: 'type', text: value.slice(6) });
    if (value.startsWith('/key ')) return void send({ type: 'key', key: value.slice(5) });
    const destination = value.startsWith('/open ') ? value.slice(6) : value;
    void send({ type: 'navigate', url: normalize(destination) });
  }

  function clickPage(event: MouseEvent) {
    if (!snapshot || !viewport) return;
    const rect = viewport.getBoundingClientRect();
    void send({
      type: 'click',
      x: (event.clientX - rect.left) * snapshot.width / rect.width,
      y: (event.clientY - rect.top) * snapshot.height / rect.height
    });
  }

  function wheelPage(event: WheelEvent) {
    event.preventDefault();
    void send({ type: 'scroll', deltaY: event.deltaY });
  }

  onMount(() => {
    const initial = String(node.payload.url || 'https://duckduckgo.com');
    void send({ type: 'navigate', url: normalize(initial) });
    poll = setInterval(refresh, 1500);
  });

  onDestroy(() => {
    if (poll) clearInterval(poll);
    void fetch(`/api/browser/session?id=${encodeURIComponent(sessionId)}`, { method: 'DELETE', keepalive: true });
  });
</script>

<div class="relative h-full overflow-hidden bg-black text-white">
  <button type="button" bind:this={viewport} class="absolute inset-0 bottom-20 grid w-full place-items-center overflow-hidden border-0 bg-black p-0 text-left" on:click={clickPage} on:wheel={wheelPage} aria-label="Interact with rendered web page">
    {#if snapshot}
      <img src={snapshot.image} alt={snapshot.title || snapshot.url} draggable="false" class="h-full w-full object-contain object-top" />
    {:else}
      <span class="font-mono text-[11px] text-neutral-500">{message}</span>
    {/if}
  </button>

  {#if snapshot}
    <div class="pointer-events-none absolute left-3 top-3 max-w-[70%] rounded-full bg-black/70 px-3 py-1 font-mono text-[9px] text-white/60 backdrop-blur">
      {snapshot.title || snapshot.url}
    </div>
  {/if}

  <form class="absolute inset-x-4 bottom-4 flex h-14 items-center rounded-full border border-white/10 bg-[#202020]/95 px-5 shadow-2xl backdrop-blur" on:submit|preventDefault={runPrompt}>
    <span class="mr-3 text-xl font-light text-white/75">+</span>
    <input bind:value={prompt} disabled={working} class="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/40" placeholder={working ? message : 'Open, search, or command HII browser'} aria-label="HII browser command" spellcheck="false" />
    <span class="ml-3 h-2 w-2 rounded-full" class:bg-blue-500={working} class:bg-green-400={!working && !!snapshot} class:bg-red-400={!working && !snapshot}></span>
  </form>
</div>
