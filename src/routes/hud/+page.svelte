<script lang="ts">
  import { onMount } from 'svelte';
  import TerminalPane from '$lib/components/TerminalPane.svelte';

  type ScreenContext = {
    status: 'captured' | 'unavailable';
    capturedAt: string;
    relativePath?: string | null;
    application?: string | null;
    width: number;
    height: number;
    message?: string | null;
  };

  const sessionId = 'hii-ambient-cli';
  let prompt = '';
  let context: ScreenContext | null = null;
  let includeContext = true;
  let terminalStatus: 'connecting' | 'ready' | 'exited' | 'error' = 'connecting';
  let terminalDetail = '';
  let input: HTMLTextAreaElement;
  let native = false;
  let busyCapture = false;

  $: contextReady = includeContext && context?.status === 'captured' && Boolean(context.relativePath);
  $: contextLabel = context?.status === 'captured'
    ? `${context.application || 'Screen'} · ${context.width}×${context.height}`
    : context?.message || 'Screen context unavailable';

  function focusPrompt() {
    requestAnimationFrame(() => input?.focus());
  }

  function terminalState(status: typeof terminalStatus, detail = '') {
    terminalStatus = status;
    terminalDetail = detail;
  }

  function send() {
    const request = prompt.trim();
    if (!request) return;
    const commands: string[] = [];
    if (contextReady && context?.relativePath) commands.push(`/attach ${context.relativePath}`);
    commands.push(request);
    window.dispatchEvent(new CustomEvent('hii:terminal-command', {
      detail: { sessionId, command: commands.join('\r') }
    }));
    prompt = '';
    includeContext = false;
    focusPrompt();
  }

  async function dismiss() {
    if (!native) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('hide_hii_hud').catch(() => {});
  }

  async function recapture() {
    if (!native || busyCapture) return;
    busyCapture = true;
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      context = await invoke<ScreenContext>('refresh_hii_hud_context');
      includeContext = context?.status === 'captured';
    } finally {
      busyCapture = false;
      focusPrompt();
    }
  }

  async function openWorkspace() {
    if (!native) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_hii_mode', { route: '/workspace' }).catch(() => {});
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void dismiss();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  onMount(() => {
    native = '__TAURI_INTERNALS__' in window;
    focusPrompt();
    if (!native) return;
    let stopContext: (() => void) | undefined;
    let stopOpened: (() => void) | undefined;
    void Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(async ([core, events]) => {
      context = await core.invoke<ScreenContext | null>('latest_screen_context').catch(() => null);
      includeContext = context?.status === 'captured';
      stopContext = await events.listen<ScreenContext>('hii://screen-context', (event) => {
        context = event.payload;
        includeContext = context?.status === 'captured';
      });
      stopOpened = await events.listen('hii://hud-opened', focusPrompt);
      focusPrompt();
    });
    return () => {
      stopContext?.();
      stopOpened?.();
    };
  });
</script>

<svelte:head><title>HII HUD</title></svelte:head>

<main class="hud-shell">
  <div class="proof-rail" class:active={terminalStatus === 'ready'} aria-hidden="true"></div>

  <header>
    <button class="wordmark" type="button" on:click={openWorkspace} aria-label="Open HII workspace">hii</button>
    <div class="context-slot">
      {#if context}
        <button
          type="button"
          class:included={contextReady}
          class:unavailable={context.status !== 'captured'}
          class="context-chip"
          on:click={() => context?.status === 'captured' && (includeContext = !includeContext)}
          title={contextReady ? 'Screen context will be attached to the next request' : contextLabel}
        >
          <span class="context-dot"></span>
          <span>{contextReady ? contextLabel : context.status === 'captured' ? 'Screen context removed' : contextLabel}</span>
          {#if context.status === 'captured'}<span class="chip-action">{contextReady ? '×' : '+'}</span>{/if}
        </button>
      {:else}
        <span class="context-chip waiting"><span class="context-dot"></span>Capturing screen context…</span>
      {/if}
    </div>
    <button class="icon-button" type="button" on:click={recapture} disabled={busyCapture} aria-label="Capture screen context again" title="Capture screen context again">↻</button>
    <span class="shortcut" aria-label="H key keyboard shortcut Option H"><b>H key</b> · ⌥H</span>
    <button class="icon-button close" type="button" on:click={dismiss} aria-label="Hide HII HUD">×</button>
  </header>

  <section class="composer" aria-label="Ask HII">
    <span class="plus" aria-hidden="true">+</span>
    <textarea
      bind:this={input}
      bind:value={prompt}
      on:keydown={keydown}
      rows="1"
      placeholder={contextReady ? 'Ask about this screen or tell HII what to do…' : 'Ask HII or describe what you want done…'}
      aria-label="Ask HII a question or give it a request"
      spellcheck="true"
    ></textarea>
    <button class="send" type="button" on:click={send} disabled={!prompt.trim()} aria-label="Send to HII">↵</button>
  </section>

  <section class="transcript" aria-label="HII CLI conversation">
    <TerminalPane
      {sessionId}
      program="hii"
      ariaLabel="Interactive HII CLI conversation"
      onStatus={terminalState}
    />
  </section>

  <footer>
    <span class="status"><i class:ready={terminalStatus === 'ready'}></i>{terminalStatus === 'ready' ? 'HII CLI ready' : terminalStatus === 'error' ? terminalDetail || 'CLI unavailable' : terminalStatus === 'exited' ? `CLI exited ${terminalDetail}` : 'Connecting to HII CLI'}</span>
    <span>Screen pixels stay local unless the selected model route sends them.</span>
  </footer>
</main>

<style>
  :global(html), :global(body) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #f7f8fb;
  }

  :global(body) {
    color: #17191d;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  }

  :global(*) { box-sizing: border-box; }

  .hud-shell {
    position: relative;
    display: grid;
    grid-template-rows: 46px 60px minmax(0, 1fr) 28px;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border: 1px solid rgba(21, 25, 31, 0.18);
    border-radius: 16px;
    background: rgba(250, 251, 253, 0.985);
    box-shadow: 0 26px 70px rgba(13, 18, 28, 0.24), 0 4px 14px rgba(13, 18, 28, 0.14);
  }

  .proof-rail {
    position: absolute;
    z-index: 4;
    inset: 0 auto 0 0;
    width: 3px;
    background: #9da4af;
    transition: background 180ms ease, box-shadow 180ms ease;
  }

  .proof-rail.active {
    background: #176bff;
    box-shadow: 1px 0 12px rgba(23, 107, 255, 0.35);
  }

  header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 9px;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid rgba(24, 28, 34, 0.10);
    background: #f1f3f7;
    -webkit-app-region: drag;
  }

  button, textarea { -webkit-app-region: no-drag; }

  .wordmark {
    border: 0;
    padding: 0;
    background: transparent;
    color: #151820;
    font: 700 16px/1 "Helvetica Neue", sans-serif;
    letter-spacing: -0.07em;
    cursor: pointer;
  }

  .context-slot { min-width: 0; }

  .context-chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    height: 27px;
    gap: 7px;
    overflow: hidden;
    border: 1px solid rgba(29, 34, 42, 0.10);
    border-radius: 999px;
    padding: 0 9px;
    background: rgba(255, 255, 255, 0.68);
    color: #68707c;
    font: 500 11px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button.context-chip { cursor: pointer; }
  .context-chip.included { border-color: rgba(23, 107, 255, 0.32); background: #eef4ff; color: #1559d5; }
  .context-chip.unavailable { border-color: rgba(167, 52, 45, 0.20); background: #fff4f2; color: #9b3a34; }
  .context-chip.waiting { color: #7a818d; }
  .context-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
  .chip-action { margin-left: 2px; font-size: 14px; }

  .icon-button {
    display: grid;
    width: 27px;
    height: 27px;
    place-items: center;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #6c737e;
    font: 500 16px/1 ui-monospace, monospace;
    cursor: pointer;
  }

  .icon-button:hover { background: rgba(24, 28, 34, 0.07); color: #17191d; }
  .icon-button:disabled { opacity: 0.4; cursor: default; }
  .icon-button.close { font-size: 18px; }

  .shortcut {
    color: #777e88;
    font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .composer {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    margin: 10px 12px 8px;
    border: 1px solid rgba(23, 107, 255, 0.48);
    border-radius: 11px;
    padding: 0 10px 0 13px;
    background: #ffffff;
    box-shadow: 0 0 0 2px rgba(23, 107, 255, 0.07);
  }

  .plus { color: #8b919a; font: 300 23px/1 "Helvetica Neue", sans-serif; }

  textarea {
    width: 100%;
    height: 44px;
    resize: none;
    border: 0;
    outline: 0;
    padding: 12px 0 8px;
    background: transparent;
    color: #191c21;
    font: 500 16px/1.35 "Helvetica Neue", sans-serif;
  }

  textarea::placeholder { color: #8c929b; }

  .send {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: #17191d;
    color: white;
    font: 600 14px/1 ui-monospace, monospace;
    cursor: pointer;
  }

  .send:disabled { background: #d7dbe1; color: #8b919a; cursor: default; }

  .transcript {
    min-height: 0;
    margin: 0 12px;
    overflow: hidden;
    border: 1px solid rgba(24, 28, 34, 0.10);
    border-radius: 10px;
    background: #fff;
  }

  .transcript :global(.xterm-host) { padding: 10px 10px 6px !important; }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    overflow: hidden;
    padding: 0 13px 0 16px;
    color: #777e89;
    font: 500 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
  }

  .status { display: inline-flex; align-items: center; gap: 6px; color: #555d68; }
  .status i { width: 6px; height: 6px; border-radius: 50%; background: #9ca3ad; }
  .status i.ready { background: #176bff; }

  button:focus-visible, textarea:focus-visible { outline: 2px solid #176bff; outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .proof-rail { transition: none; }
  }
</style>
