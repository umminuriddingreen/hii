<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';

  let intent = '';
  let input: HTMLInputElement;
  let busy = false;
  let error = '';

  async function dismiss() {
    intent = '';
    error = '';
    await invoke('hide_cursor_bar');
  }

  async function run() {
    const goal = intent.trim();
    if (!goal || busy) return;
    busy = true;
    error = '';
    try {
      await invoke<string>('run_cursor_intent', { goal });
      intent = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      busy = false;
      await tickFocus();
    }
  }

  async function tickFocus() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    input?.focus();
    input?.select();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void dismiss();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void run();
    }
  }

  onMount(() => {
    let stop: (() => void) | undefined;
    void listen('hii://cursor-bar-opened', () => {
      busy = false;
      error = '';
      void tickFocus();
    }).then((unlisten) => {
      stop = unlisten;
    });
    void tickFocus();
    return () => stop?.();
  });
</script>

<svelte:head><title>HII</title></svelte:head>

<main class:error class="cursor-bar">
  <div class="mark" aria-hidden="true">hii</div>
  <input
    bind:this={input}
    bind:value={intent}
    disabled={busy}
    aria-label="Tell HII what you want to happen"
    aria-describedby={error ? 'cursor-bar-status' : undefined}
    autocomplete="off"
    spellcheck="true"
    placeholder={busy ? 'Starting verified work…' : 'What do you want to happen?'}
    on:keydown={keydown}
  />
  <div class="key" aria-hidden="true">{busy ? '•••' : '↵'}</div>
  {#if error}<p id="cursor-bar-status" role="alert">{error}</p>{/if}
</main>

<style>
  :global(html), :global(body) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #fafaf7;
  }

  :global(body) {
    display: grid;
    place-items: center;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  .cursor-bar {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    width: 100%;
    min-height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid rgba(16, 18, 20, 0.18);
    border-radius: 0;
    background: rgba(250, 250, 247, 0.97);
    box-shadow: 0 18px 48px rgba(10, 13, 17, 0.22), 0 2px 8px rgba(10, 13, 17, 0.12);
    backdrop-filter: blur(22px) saturate(1.2);
  }

  .cursor-bar::after {
    position: absolute;
    inset: auto 0 0;
    height: 3px;
    content: "";
    background: #176bff;
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 160ms ease;
  }

  .cursor-bar:focus-within::after {
    transform: scaleX(1);
  }

  .cursor-bar.error::after {
    background: #c73b32;
    transform: scaleX(1);
  }

  .mark {
    margin-left: 17px;
    color: #15171a;
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.06em;
  }

  input {
    min-width: 0;
    height: 54px;
    border: 0;
    padding: 0 15px;
    outline: 0;
    background: transparent;
    color: #15171a;
    font: 500 17px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
    letter-spacing: -0.015em;
  }

  input::placeholder {
    color: #85898e;
  }

  input:disabled {
    color: #676c73;
    opacity: 1;
  }

  .key {
    display: grid;
    min-width: 28px;
    height: 26px;
    margin-right: 14px;
    place-items: center;
    border: 1px solid rgba(21, 23, 26, 0.12);
    border-radius: 7px;
    background: rgba(21, 23, 26, 0.055);
    color: #73777c;
    font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  p {
    position: absolute;
    inset: auto 17px 1px 47px;
    overflow: hidden;
    margin: 0;
    color: #a8322b;
    font-size: 10px;
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .cursor-bar::after { transition: none; }
  }
</style>
