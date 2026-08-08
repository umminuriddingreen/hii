<script lang="ts">
  import { onMount } from 'svelte';
  import {
    voiceApprove,
    voiceCancel,
    voiceInterpret,
    voiceProposals,
    type VoiceApiRuntimeState,
  } from '$lib/voice/client';

  type VoiceApiProposal = {
    id: string;
    status: 'pending' | 'queued' | 'executed' | 'failed' | 'cancelled';
    purpose?: string;
    confidence?: number;
    createdAt?: string;
    lastError?: string;
  };

  type NotchSummary = { active?: { summary?: string; status?: string }; recent?: Array<{ summary?: string; status?: string }> };

  type VoiceRuntimeSnapshot = {
    updatedAt: string;
    intentFile: string;
    proposalCount: number;
    activeEngines: Array<{ id: string; name: string; transport: string; privacy: string; latencyHint: string }>;
    pendingApprovals: number;
  };

  let expanded = true;
  let intent = '';
  let liveTranscript = '';
  let busy = false;
  let speechBusy = false;
  let error = '';
  let message = '';
  let summary: NotchSummary | null = null;
  let voiceRuntime: VoiceRuntimeSnapshot | null = null;
  let proposals: VoiceApiProposal[] = [];
  let proposalError = '';
  let native = false;
  let supportsSpeech = false;
  let isListening = false;
  let shouldRetryRecognition = false;
  let latestQueuedRunId: string | null = null;

  let recognition: any = null;
  let finalTranscript = '';
  let input: HTMLInputElement;

  async function emitNotchEvent({ summaryText, status = 'ready' }: { summaryText: string; status?: string }) {
    await fetch('/api/ecosystem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'event',
        mode: 'notch',
        projectId: 'default',
        status,
        summary: summaryText,
        object: {
          kind: 'run',
          id: latestQueuedRunId || crypto.randomUUID()
        }
      })
    }).catch(() => null);
  }

  async function refresh() {
    try {
      const [notchResponse, voiceResponse, proposalResponse] = await Promise.all([
        fetch('/api/ecosystem?mode=summary'),
        fetch('/api/voice?mode=snapshot'),
        voiceProposals()
      ]);
      if (notchResponse.ok) summary = await notchResponse.json();
      if (voiceResponse.ok) voiceRuntime = await voiceResponse.json();
      if (proposalResponse?.proposals) proposals = proposalResponse.proposals as VoiceApiProposal[];
    } catch {
      // transient network failures are non-blocking
    }
  }

  async function setExpanded(value: boolean) {
    expanded = value;
    error = '';
    if (native) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_notch_expanded', { expanded: value }).catch(() => {});
    }
    if (value) requestAnimationFrame(() => input?.focus());
  }

  async function openMode(route: '/browser' | '/create' | '/workspace') {
    if (native) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_hii_mode', { route });
      await setExpanded(false);
      return;
    }

    location.href = route;
  }

  function stripCommandArtifacts(value: string) {
    return value
      .replace(/\s+/g, ' ')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim();
  }

  async function interpretAndRoute(rawText: string) {
    const clean = stripCommandArtifacts(rawText);
    if (!clean || busy) return;
    busy = true;
    error = '';
    message = '';
    finalTranscript = '';
    liveTranscript = '';
    try {
      const state = (await voiceInterpret({ utterance: clean, requestedBy: 'notch' })) as VoiceApiRuntimeState;
      const nextMessage = typeof state.message === 'string' ? state.message : 'Voice intent interpreted.';
      message = nextMessage;
      latestQueuedRunId = state.queuedRunId || null;
      if (state.queuedRunId) {
        await emitNotchEvent({ summaryText: clean, status: 'running' });
      }
      if (!state.requiresUserAction) {
        intent = '';
        await setTimeout(() => refresh(), 200);
      }
      if (!state.requiresUserAction && !state.queuedRunId) {
        latestQueuedRunId = null;
      }
      if (!state.requiresUserAction) {
        await setExpanded(false);
      }
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not route voice intent.';
    } finally {
      busy = false;
      speechBusy = false;
      if (!isListening) {
        intent = '';
      }
    }
  }

  async function runFromTextInBrowser() {
    if (!intent.trim() || busy || speechBusy) return;
    await interpretAndRoute(intent);
  }

  async function approveProposalFromList(proposalId: string) {
    if (!proposalId || busy) return;
    busy = true;
    error = '';
    proposalError = '';
    try {
      const state = (await voiceApprove({ proposalId, requestedBy: 'notch' })) as VoiceApiRuntimeState;
      message = typeof state.message === 'string' ? state.message : 'Action approved and queued.';
      latestQueuedRunId = state.queuedRunId || latestQueuedRunId;
      if (state.queuedRunId) {
        await emitNotchEvent({ summaryText: state.queuedRunId, status: 'running' });
      }
      await refresh();
    } catch (cause) {
      proposalError = cause instanceof Error ? cause.message : 'Could not approve proposal.';
    } finally {
      busy = false;
    }
  }

  async function cancelProposalFromList(proposalId: string) {
    if (!proposalId || busy) return;
    busy = true;
    error = '';
    proposalError = '';
    try {
      const state = (await voiceCancel({ proposalId, requestedBy: 'notch', reason: 'cancelled from notch list' })) as VoiceApiRuntimeState;
      message = typeof state.message === 'string' ? state.message : 'Action cancelled.';
      await refresh();
    } catch (cause) {
      proposalError = cause instanceof Error ? cause.message : 'Could not cancel proposal.';
    } finally {
      busy = false;
    }
  }

  function startVoiceCapture() {
    if (speechBusy || !supportsSpeech) return;
    if (!recognition) {
      const ctor = (window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition
        || (window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).webkitSpeechRecognition;
      if (!ctor) return;
      recognition = new ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        isListening = true;
        speechBusy = true;
        error = '';
        message = 'Listening…'
;
      };
      recognition.onerror = (event: any) => {
        if (event?.error === 'no-speech') {
          shouldRetryRecognition = true;
          return;
        }
        error = `Voice input error: ${String(event?.error || 'unknown')}`;
        message = '';
        isListening = false;
        speechBusy = false;
      };

      recognition.onend = () => {
        isListening = false;
        speechBusy = false;
        if (shouldRetryRecognition) {
          shouldRetryRecognition = false;
          message = 'No speech detected, try again.';
          startVoiceCapture();
          return;
        }
        if (finalTranscript || liveTranscript) {
          intent = `${finalTranscript} ${liveTranscript}`.trim();
          void interpretAndRoute(intent);
          return;
        }
        message = 'No speech captured.';
      };

      recognition.onresult = (event: any) => {
        let interim = '';
        let addedFinal = '';
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          const text = String(result[0]?.transcript || '').replace(/\s+/g, ' ');
          if (result.isFinal) {
            addedFinal += `${text} `;
          } else {
            interim += `${text} `;
          }
        }
        if (addedFinal) finalTranscript = `${finalTranscript} ${addedFinal}`.trim();
        liveTranscript = interim.trim();
      };
    }

    finalTranscript = '';
    liveTranscript = '';
    shouldRetryRecognition = false;
    recognition.start();
  }

  function stopVoiceCapture() {
    if (!recognition || !isListening) return;
    recognition.stop();
  }

  async function runText(event?: SubmitEvent | KeyboardEvent) {
    event?.preventDefault();
    if (!intent.trim()) return;
    await runFromTextInBrowser();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void setExpanded(false);
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void runText(event);
    }
  }

  onMount(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stops: Array<() => void> = [];
    void refresh();
    timer = setInterval(() => void refresh(), 3000);

    (async () => {
      try {
        const core = await import('@tauri-apps/api/core');
        native = core.isTauri();
      } catch {
        native = false;
      }

      if (native) {
        expanded = false;
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');
        await invoke('set_notch_expanded', { expanded: false });
        await invoke('hide_cursor_bar').catch(() => {});
        stops.push(await listen('hii://notch-opened', () => void setExpanded(true)));
        stops.push(await listen('hii://cursor-bar-opened', () => void setExpanded(true)));
      }

      const ctor =
        typeof window !== 'undefined'
          ? (window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition
            || (window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).webkitSpeechRecognition
          : null;
      supportsSpeech = Boolean(ctor);

      if (!supportsSpeech) {
        message = 'Browser speech recognition unavailable. You can still type commands.';
      }
    })().catch(() => {
      message = 'Voice surface initialization failed.';
    });

    return () => {
      if (timer) clearInterval(timer);
      stops.forEach((stop) => stop());
      if (recognition) {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onstart = null;
      }
      if (isListening) stopVoiceCapture();
    };
  });
</script>

<svelte:head>
  <title>Notch — HII</title>
</svelte:head>

<main class:expanded class="notch-shell">
  {#if !expanded}
    <button class="collapsed" on:click={() => void setExpanded(true)} aria-label="Open HII Notch">
      <i class:active={Boolean(summary?.active)}></i>
      <strong>hii</strong>
      <span>{summary?.active?.summary || summary?.recent?.[0]?.summary || 'Notch'}</span>
      <b>{summary?.active?.status || 'ready'}</b>
    </button>
  {:else}
    <section class="expanded-panel">
      <header>
        <div>
          <i class:active={Boolean(summary?.active)}></i>
          <strong>Notch</strong>
          <span>{summary?.active?.status || 'local'}</span>
        </div>
        <button on:click={() => void setExpanded(false)} aria-label="Collapse Notch">−</button>
      </header>

      <form on:submit|preventDefault={runText}>
        <input
          bind:this={input}
          bind:value={intent}
          on:keydown={keydown}
          disabled={speechBusy}
          placeholder={supportsSpeech ? 'Press and hold mic, or type here…' : 'Type here to issue an intent'}
          aria-label="Tell HII what you want to happen"
        />
        <button disabled={!intent.trim() || busy || speechBusy} type="submit">↵</button>
      </form>

      <div class="voice-controls">
        <button
          class:armed={isListening}
          on:pointerdown|preventDefault={startVoiceCapture}
          on:pointerup|preventDefault={stopVoiceCapture}
          on:pointerleave|preventDefault={stopVoiceCapture}
          disabled={busy || !supportsSpeech}
          title="Hold to speak"
        >
          {#if isListening}
            Release to send
          {:else}
            Hold to speak
          {/if}
        </button>
        <span class="small-note">{message || liveTranscript || summary?.active?.summary || 'ready'}</span>
      </div>

      {#if liveTranscript}
        <div class="transcript">{liveTranscript}</div>
      {/if}

      <nav>
        <button on:click={() => void openMode('/browser')}>Browser</button>
        <button on:click={() => void openMode('/create')}>Create</button>
        <button on:click={() => void openMode('/workspace')}>Workspace</button>
      </nav>

      <div class="voice-meta">
        <p>Voice runtime</p>
        <small>{voiceRuntime?.proposalCount ?? 0} proposals · {voiceRuntime?.pendingApprovals ?? 0} pending</small>
      </div>

      {#if proposals.filter((proposal) => ['pending', 'queued'].includes(proposal.status)).length}
        <div class="proposal-list">
          <p>Recent proposals</p>
          {#each proposals.filter((proposal) => ['pending', 'queued', 'failed', 'cancelled'].includes(proposal.status)).slice(0, 4) as proposal}
            <article>
              <b>{proposal.status}</b>
              <span>{proposal.id}</span>
              <button
                disabled={busy}
                on:click={() => void approveProposalFromList(proposal.id)}
              >
                Approve
              </button>
              <button
                class="danger"
                disabled={busy || proposal.status === 'cancelled'}
                on:click={() => void cancelProposalFromList(proposal.id)}
              >
                Cancel
              </button>
            </article>
          {/each}
        </div>
      {/if}

      <div class="activity">
        <p>Recent system state</p>
        {#each summary?.recent?.slice(0, 4) || [] as event}
          <article><i class:running={['queued', 'running'].includes(event.status || '')}></i><span>{event.summary}</span><b>{event.status}</b></article>
        {:else}
          <article><i></i><span>No captured work yet.</span><b>ready</b></article>
        {/each}
      </div>

      {#if error}<p class="error">{error}</p>{/if}
      {#if proposalError}<p class="error">{proposalError}</p>{/if}
      {#if message && !liveTranscript}<p class="message">{message}</p>{/if}
    </section>
  {/if}
</main>

<style>
  :global(html),
  :global(body) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent !important;
  }

  .notch-shell {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: 0 8px 8px;
    color: white;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }

  .collapsed {
    display: grid;
    grid-template-columns: 8px auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 44px;
    border: 0;
    border-radius: 0 0 18px 18px;
    background: #090a0b;
    color: white;
    padding: 0 15px;
    box-shadow: 0 10px 32px rgba(0,0,0,.3);
    text-align: left;
  }

  .collapsed i,
  header i,
  .activity i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #65686d;
  }

  .collapsed i.active,
  header i.active,
  .activity i.running {
    background: #58e47e;
    box-shadow: 0 0 12px #58e47e;
  }

  .collapsed strong { font-size: 13px; letter-spacing: -0.04em; }
  .collapsed span { overflow: hidden; color: #b4b7bc; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .collapsed b { color: #74787e; font: 8px ui-monospace, monospace; text-transform: uppercase; }

  .expanded-panel {
    height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    border-radius: 0 0 24px 24px;
    background: rgba(9, 10, 11, 0.97);
    box-shadow: 0 18px 55px rgba(0,0,0,.38);
    backdrop-filter: blur(24px);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 17px 10px;
  }

  header > div { display: flex; align-items: center; gap: 9px; }
  header strong { font-size: 14px; }
  header span { color: #6f7379; font: 8px ui-monospace, monospace; text-transform: uppercase; }
  header button { border: 0; background: transparent; color: #777; font-size: 16px; }

  form {
    display: flex;
    align-items: center;
    margin: 0 14px;
    border: 1px solid #303238;
    border-radius: 14px;
    background: #15171a;
    padding: 4px;
  }

  form input {
    min-width: 0;
    flex: 1;
    height: 43px;
    border: 0;
    background: transparent;
    color: white;
    padding: 0 11px;
    outline: 0;
    font-size: 14px;
  }

  form input::placeholder { color: #686c72; }

  form button {
    width: 36px;
    height: 34px;
    border: 0;
    border-radius: 10px;
    background: #176bff;
    color: #fff;
  }

  .voice-controls {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    padding: 8px 14px;
    align-items: center;
  }

  .voice-controls button {
    border: 0;
    border-radius: 12px;
    background: #15171a;
    color: #c2c6cc;
    height: 34px;
    padding: 0 12px;
  }

  .voice-controls button.armed { background: #1f2230; color: #fff; }
  .small-note {
    color: #8f949a;
    font: 10px ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .transcript {
    margin: 0 14px;
    color: #fff;
    padding: 10px;
    border-radius: 10px;
    background: #11151a;
    border: 1px solid #2b2f36;
    min-height: 22px;
    font-size: 11px;
  }

  nav {
    display: flex;
    gap: 7px;
    padding: 10px 14px;
  }

  nav button {
    flex: 1;
    height: 31px;
    border: 1px solid #2b2e33;
    border-radius: 9px;
    background: #15171a;
    color: #b9bcc1;
    font: 8px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .proposal-list {
    margin: 0 14px 10px;
    border-top: 1px solid #24262a;
    padding-top: 8px;
  }

  .proposal-list > p {
    margin: 0 0 5px;
    color: #62666c;
    font: 8px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .proposal-list article {
    display: grid;
    gap: 6px;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    margin: 5px 0;
    padding: 5px;
    border-radius: 8px;
    border: 1px solid #2b2e33;
  }

  .proposal-list b {
    color: #9aa0a6;
    font: 8px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .proposal-list span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #c5c7ca;
    font-size: 10px;
  }

  .proposal-list button {
    height: 26px;
    padding: 0 9px;
    min-width: 58px;
    border: 1px solid #2b2e33;
    border-radius: 8px;
    background: #15171a;
    color: #b9bcc1;
    font: 8px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .proposal-list button.danger {
    color: #ffd1cc;
    border-color: #5a2f35;
    background: #2b1516;
  }

  .voice-meta {
    margin: 0 14px;
    padding-top: 6px;
    border-top: 1px solid #24262a;
    color: #7a7f84;
    font: 8px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .activity {
    margin: 0 14px;
    padding-top: 8px;
    border-top: 1px solid #24262a;
  }

  .activity > p {
    margin: 0 0 5px;
    color: #62666c;
    font: 8px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .activity article {
    display: grid;
    grid-template-columns: 7px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
  }

  .activity span {
    overflow: hidden;
    color: #c5c7ca;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity b {
    color: #666a70;
    font: 7px ui-monospace, monospace;
    text-transform: uppercase;
  }

  .error { margin: 6px 14px; color: #ff7d72; font-size: 9px; }
  .message { margin: 6px 14px; color: #9aa0a6; font-size: 9px; }
</style>
