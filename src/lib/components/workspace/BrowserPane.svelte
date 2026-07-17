<script lang="ts">
  import { onMount } from 'svelte';
  import type { Webview } from '@tauri-apps/api/webview';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
  export let onPayload: (patch: Record<string, unknown>) => void;

  type Result = { title: string; url: string; description: string };
  type View = 'idle' | 'loading' | 'page' | 'blocked' | 'results' | 'error';
  type EmbedMode = 'detecting' | 'native' | 'web';

  let input = String(node.payload.url ?? node.payload.query ?? '');
  let view: View = 'idle';
  let embedMode: EmbedMode = 'detecting';
  let url = '';
  let results: Result[] = [];
  let message = '';
  let history: string[] = [];
  let index = -1;
  let nativeFrame: HTMLDivElement;
  let nativeWebview: Webview | null = null;
  let invokeNative: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
  let restored = false;
  const browserLabel = `hii-browser-${node.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  const normalize = (value: string) => /^https?:\/\//i.test(value)
    ? value
    : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)
      ? `https://${value}`
      : null;

  async function navigate(value: string, push = true) {
    const next = normalize(value) ?? value;
    if (!/^https?:\/\//i.test(next)) return search(value);
    input = next;
    url = next;
    view = 'loading';
    onPayload({ url: next, title: new URL(next).hostname });
    if (push) {
      history = [...history.slice(0, index + 1), next];
      index = history.length - 1;
    }

    try {
      if (embedMode === 'native' && invokeNative) {
        await invokeNative('browser_navigate', { label: browserLabel, url: next });
        view = 'page';
        return;
      }
      const response = await fetch(`/api/browse/check?url=${encodeURIComponent(next)}`);
      const data = await response.json();
      url = data.finalUrl || next;
      view = data.frameable ? 'page' : 'blocked';
    } catch {
      view = 'error';
      message = 'embedded browsing failed';
    }
  }

  async function search(query: string) {
    view = 'loading';
    onPayload({ query, title: `search: ${query}` });
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok || !data.results) throw new Error('search unavailable');
      results = data.results;
      view = 'results';
    } catch {
      await navigate(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
    }
  }

  function submit() {
    const value = input.trim();
    if (value) void (normalize(value) ? navigate(value) : search(value));
  }

  function go(delta: number) {
    const next = index + delta;
    if (!history[next]) return;
    index = next;
    void navigate(history[next], false);
  }

  function home() {
    view = 'idle';
    input = '';
    url = '';
    onPayload({ url: '', query: '', title: 'browser' });
  }

  async function external() {
    await fetch('/api/files/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
  }

  function restore() {
    if (restored) return;
    restored = true;
    if (input) void navigate(input);
  }

  $: status = embedMode === 'detecting'
    ? 'starting embed'
    : view === 'page'
      ? embedMode === 'native' ? 'native embedded' : 'web embedded'
      : view === 'blocked' ? 'external only' : view;

  onMount(() => {
    let disposed = false;
    let frame = 0;
    let chromeOffset = 0;
    let shown = false;
    let lastBounds = '';
    let resizeHandler: (() => void) | null = null;

    const activateWeb = () => {
      if (disposed) return;
      embedMode = 'web';
      restore();
    };

    const start = async () => {
      const core = await import('@tauri-apps/api/core');
      if (!core.isTauri()) return activateWeb();

      const [{ Webview }, { getCurrentWindow }, { LogicalPosition, LogicalSize }] = await Promise.all([
        import('@tauri-apps/api/webview'),
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/dpi')
      ]);
      invokeNative = core.invoke;
      const window = getCurrentWindow();
      const updateChromeOffset = async () => {
        const [inner, outer, scale] = await Promise.all([window.innerSize(), window.outerSize(), window.scaleFactor()]);
        chromeOffset = (outer.height - inner.height) / scale;
      };
      await updateChromeOffset();

      const activate = async (webview: Webview) => {
        if (disposed) return void webview.hide().catch(() => {});
        nativeWebview = webview;
        await webview.hide().catch(() => {});
        embedMode = 'native';
        restore();
      };

      const existing = await Webview.getByLabel(browserLabel);
      if (existing) {
        await activate(existing);
      } else {
        const webview = new Webview(window, browserLabel, { url: 'about:blank', x: 0, y: 0, width: 1, height: 1 });
        nativeWebview = webview;
        await webview.once('tauri://created', () => void activate(webview));
        await webview.once('tauri://error', activateWeb);
      }

      const sync = () => {
        if (disposed) return;
        const rect = nativeFrame?.getBoundingClientRect();
        const paletteOpen = Boolean(document.querySelector('[role="dialog"][aria-label="Create workspace object"]'));
        const visible = view === 'page' && document.visibilityState === 'visible' && !paletteOpen && Boolean(
          rect && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        );
        if (visible && rect && nativeWebview) {
          const bounds = [rect.x, rect.y, rect.width, rect.height].map((value) => value.toFixed(1)).join(':');
          if (bounds !== lastBounds) {
            lastBounds = bounds;
            Promise.all([
              nativeWebview.setPosition(new LogicalPosition(rect.x, rect.y + chromeOffset)),
              nativeWebview.setSize(new LogicalSize(rect.width, rect.height))
            ]).catch(() => {});
          }
          if (!shown) {
            shown = true;
            nativeWebview.show().catch(() => {});
          }
        } else if (shown && nativeWebview) {
          shown = false;
          nativeWebview.hide().catch(() => {});
        }
        frame = requestAnimationFrame(sync);
      };
      sync();
      resizeHandler = () => void updateChromeOffset();
      addEventListener('resize', resizeHandler);
    };

    start().catch(activateWeb);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (resizeHandler) removeEventListener('resize', resizeHandler);
      nativeWebview?.hide().catch(() => {});
    };
  });
</script>

<div class="flex h-full flex-col bg-white">
  <div class="flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
    <button aria-label="back" disabled={index <= 0} on:click={() => go(-1)}>←</button>
    <button aria-label="forward" disabled={index < 0 || index >= history.length - 1} on:click={() => go(1)}>→</button>
    <button aria-label="reload" disabled={!url} on:click={() => url && navigate(url, false)}>↻</button>
    <button aria-label="HII browser home" on:click={home}>h</button>
    <input class="w-full bg-transparent font-mono text-[11px] outline-none" bind:value={input} on:keydown={(event) => { if (event.key === 'Enter') submit(); event.stopPropagation(); }} placeholder="url or search…" spellcheck="false" />
    <span class="shrink-0 rounded-full border px-2 font-mono text-[9px] text-neutral-400">{status}</span>
  </div>
  <div class="scroll relative min-h-0 flex-1 overflow-auto">
    {#if view === 'idle'}
      <div class="grid h-full place-items-center text-center"><div><strong class="font-mono text-xs">browser, inside HII</strong><p class="mt-1 text-[11px] text-neutral-400">full websites stay inside the workspace in the native app</p></div></div>
    {:else if view === 'loading'}
      <div class="grid h-full place-items-center font-mono text-[11px] text-neutral-400">loading…</div>
    {:else if view === 'page' && embedMode === 'native'}
      <div bind:this={nativeFrame} class="grid h-full w-full place-items-center bg-white font-mono text-[10px] text-neutral-300">native browser embedded in HII</div>
    {:else if view === 'page'}
      <iframe src={url} title={url} sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" class="h-full w-full border-0"></iframe>
    {:else if view === 'blocked'}
      <div class="grid h-full place-items-center p-6 text-center"><div><strong>this site blocks iframe browsing</strong><p class="mt-2 break-all font-mono text-[10px]">{url}</p><button class="hii-command-button mt-4" on:click={external}>open externally</button></div></div>
    {:else if view === 'results'}
      <div class="divide-y">{#each results as result}<button class="block w-full p-3 text-left hover:bg-neutral-50" on:click={() => navigate(result.url)}><strong class="text-[13px] text-[var(--hii-electric-blue)]">{result.title}</strong><small class="block truncate font-mono text-[9px] text-neutral-400">{result.url}</small><p class="mt-1 line-clamp-2 text-[11px]">{result.description}</p></button>{/each}</div>
    {:else}
      <div class="grid h-full place-items-center font-mono text-[11px]">{message}</div>
    {/if}
  </div>
</div>
