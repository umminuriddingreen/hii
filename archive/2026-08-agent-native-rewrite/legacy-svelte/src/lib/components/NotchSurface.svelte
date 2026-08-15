<script lang="ts">
  import { onMount } from 'svelte';
  import {
    voiceApprove,
    voiceCancel,
    voiceInterpret,
    voiceProposals,
    type VoiceApiRuntimeState,
  } from '$lib/voice/client';
  import { emptyNotchInputs, notchPresentation } from '@/lib/notch/ambient-state';

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

  // --- ambient state --------------------------------------------------------
  // The Notch answers one question: what needs my attention right now? It used
  // to decide that from a handful of independent booleans, which multiply into
  // combinations nobody enumerated and which could contradict each other. The
  // state model resolves them to exactly one answer with one primary action.
  // Native window mechanics are untouched: positioning, always-on-top,
  // all-spaces, expansion and the global shortcut stay in the Tauri layer.
  let liveSelection: { workspaceId: string; selectedNodeIds: string[] } | null = null;
  let lastCompletedRun: { id: string; summary: string; satisfied: boolean } | null = null;
  $: ambient = notchPresentation({
    ...emptyNotchInputs(),
    capturing: expanded && !isListening && !busy,
    listening: isListening,
    transcribing: speechBusy,
    interpreting: busy,
    error,
    unseenProposal: null,
    pendingProposals: proposals
      .filter((proposal) => proposal.status === 'pending')
      .map((proposal) => ({ id: proposal.id, summary: proposal.purpose || 'An action is waiting.' })),
    activeRun: summary?.active
      ? { id: latestQueuedRunId || 'active', summary: summary.active.summary || 'Working…', status: summary.active.status || 'running' }
      : null,
    lastCompletedRun,
    selection: liveSelection
  });
  // Coordinates only, from the ephemeral cross-window channel. The Notch shows a
  // count; the ids are resolved server-side against the persisted workspace.
  async function refreshSelection() {
    try {
      const response = await fetch('/api/workspace/selection');
      const result = await response.json();
      liveSelection = response.ok && result.selection
        ? { workspaceId: result.selection.workspaceId, selectedNodeIds: result.selection.selectedNodeIds }
        : null;
    } catch {
      liveSelection = null;
    }
  }

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

  function openFromNotchHover() {
    if (!expanded) void setExpanded(true);
  }

  function collapseAfterHover(event: PointerEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return;
    if (document.activeElement && event.currentTarget instanceof Node && event.currentTarget.contains(document.activeElement)) return;
    if (isListening || busy || speechBusy) return;
    void setExpanded(false);
  }

  onMount(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stops: Array<() => void> = [];
    void refresh();
    void refreshSelection();
    timer = setInterval(() => {
      void refresh();
      // The live selection is what lets a spoken intent say "these" and mean the
      // objects on the canvas in the other window.
      void refreshSelection();
    }, 3000);

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

<main class:expanded class="notch-shell" data-state={ambient.state.toLowerCase()} on:pointerenter={openFromNotchHover} on:pointerleave={collapseAfterHover}>
  {#if !expanded}
    <button class="collapsed" on:pointerenter={openFromNotchHover} on:click={() => void setExpanded(true)} aria-label="Open HII Notch">
      <i class:active={Boolean(summary?.active)}><span></span></i>
      <strong>HII</strong>
      <span>{ambient.message}</span>
      <b>{ambient.state.toLowerCase().replace(/_/g, ' ')}</b>
    </button>
  {:else}
    <section class="expanded-panel">
      <header>
        <div>
          <i class:active={Boolean(summary?.active)}><span></span></i>
          <strong>HII</strong>
          <span>{ambient.state.toLowerCase().replace(/_/g, ' ')}</span>
        </div>
        <button on:click={() => void setExpanded(false)} aria-label="Collapse Notch">−</button>
      </header>

      <!-- One sentence and one action. Everything else lives below, so the
           surface never asks the human to decide what it should have decided. -->
      <section class="live-card" aria-label="HII live activity">
        <div class="orbital-status" aria-hidden="true">
          <span></span>
          <b></b>
        </div>
        <div class="live-copy">
          <p class="ambient-line" role="status" aria-live="polite">{ambient.message}</p>
          <small>{liveSelection?.selectedNodeIds.length || 0} selected · {voiceRuntime?.pendingApprovals ?? 0} approvals · {summary?.active ? 'working' : 'ready'}</small>
        </div>
      </section>

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

      <div class="control-strip">
        <button
          class:armed={isListening}
          class="voice-button"
          on:pointerdown|preventDefault={startVoiceCapture}
          on:pointerup|preventDefault={stopVoiceCapture}
          on:pointerleave|preventDefault={stopVoiceCapture}
          disabled={busy || !supportsSpeech}
          title="Hold to speak"
        >
          <span>{isListening ? 'Listening' : 'Voice'}</span>
          <b>{isListening ? 'release' : 'hold'}</b>
        </button>
        <span class="small-note">{message || liveTranscript || summary?.active?.summary || 'Grounded local context is ready.'}</span>
      </div>

      <div class="voice-controls" hidden>
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
        <button on:click={() => void openMode('/browser')}><span>Browse</span><b>ground</b></button>
        <button on:click={() => void openMode('/create')}><span>Create</span><b>make</b></button>
        <button on:click={() => void openMode('/workspace')}><span>Space</span><b>objects</b></button>
      </nav>

      <div class="voice-meta">
        <p>Context shelf</p>
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
    padding: 0 9px 9px;
    color: white;
    font-family: Inter, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }

  .collapsed {
    display: grid;
    grid-template-columns: 18px auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 42px;
    border: 0;
    border-radius: 0 0 21px 21px;
    background:
      linear-gradient(180deg, rgba(26, 28, 31, .96), rgba(6, 7, 9, .98)),
      #090a0b;
    color: white;
    padding: 0 14px;
    box-shadow: 0 14px 34px rgba(0,0,0,.34), inset 0 -1px 0 rgba(255,255,255,.08);
    text-align: left;
    transition: transform 180ms ease, box-shadow 180ms ease;
  }

  .collapsed:hover { transform: translateY(1px); box-shadow: 0 18px 44px rgba(0,0,0,.42), inset 0 -1px 0 rgba(255,255,255,.1); }

  .collapsed i,
  header i,
  .activity i {
    position: relative;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #6f747d;
  }

  .collapsed i span,
  header i span {
    position: absolute;
    inset: -4px;
    border-radius: 999px;
    border: 1px solid rgba(111, 116, 125, .45);
  }

  .collapsed i.active,
  header i.active,
  .activity i.running {
    background: #62f0a2;
    box-shadow: 0 0 18px rgba(98, 240, 162, .7);
  }

  .collapsed i.active span,
  header i.active span { border-color: rgba(98, 240, 162, .42); }

  .collapsed strong { font-size: 12px; font-weight: 760; letter-spacing: .01em; }
  .collapsed span { overflow: hidden; color: #c9ced6; font-size: 11px; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
  .collapsed b {
    min-width: 62px;
    border-radius: 999px;
    background: rgba(255,255,255,.07);
    color: #939aa5;
    font: 700 7px/18px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-align: center;
    text-transform: uppercase;
  }

  /* The one sentence. Sized to be read at a glance from the edge of the screen. */
  .ambient-line {
    margin: 0;
    color: #f2f5f8;
    font-size: 16px;
    font-weight: 720;
    line-height: 1.18;
    letter-spacing: 0;
  }

  .expanded-panel {
    height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.08);
    border-top: 0;
    border-radius: 0 0 28px 28px;
    background:
      radial-gradient(circle at 20% 5%, rgba(68, 161, 255, .26), transparent 30%),
      radial-gradient(circle at 82% 10%, rgba(98, 240, 162, .14), transparent 24%),
      linear-gradient(180deg, rgba(19, 22, 27, .98), rgba(8, 9, 12, .985));
    box-shadow: 0 28px 80px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.08);
    backdrop-filter: blur(28px) saturate(1.18);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 15px 18px 9px;
  }

  header > div { display: flex; align-items: center; gap: 9px; }
  header strong { font-size: 13px; font-weight: 780; letter-spacing: .01em; }
  header span { color: #89919d; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
  header button {
    width: 26px;
    height: 24px;
    border: 0;
    border-radius: 999px;
    background: rgba(255,255,255,.06);
    color: #a9b0ba;
    font-size: 16px;
  }

  .live-card {
    display: grid;
    grid-template-columns: 54px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    margin: 0 14px 11px;
    padding: 13px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 20px;
    background: rgba(255,255,255,.055);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
  }

  .orbital-status {
    position: relative;
    display: grid;
    width: 48px;
    height: 48px;
    place-items: center;
    border-radius: 999px;
    background: conic-gradient(from 210deg, #62f0a2, #44a1ff, #c6a7ff, #62f0a2);
  }

  .orbital-status::before {
    position: absolute;
    inset: 5px;
    border-radius: inherit;
    background: #0c0e12;
    content: "";
  }

  .orbital-status span {
    position: relative;
    width: 16px;
    height: 16px;
    border-radius: inherit;
    background: #62f0a2;
    box-shadow: 0 0 22px rgba(98, 240, 162, .75);
  }

  .orbital-status b {
    position: absolute;
    inset: -3px;
    border-radius: inherit;
    border: 1px solid rgba(255,255,255,.12);
  }

  .live-copy { min-width: 0; }
  .live-copy small {
    display: block;
    overflow: hidden;
    margin-top: 5px;
    color: #8f98a4;
    font: 700 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  form {
    display: flex;
    align-items: center;
    margin: 0 14px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 16px;
    background: rgba(3, 4, 6, .64);
    padding: 4px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
  }

  form input {
    min-width: 0;
    flex: 1;
    height: 43px;
    border: 0;
    background: transparent;
    color: white;
    padding: 0 12px;
    outline: 0;
    font-size: 13px;
    font-weight: 560;
  }

  form input::placeholder { color: #747d88; }

  form button {
    width: 36px;
    height: 34px;
    border: 0;
    border-radius: 12px;
    background: linear-gradient(135deg, #44a1ff, #176bff);
    color: #fff;
    box-shadow: 0 8px 20px rgba(23, 107, 255, .28);
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

  .voice-controls[hidden] { display: none; }

  .control-strip {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 9px;
    align-items: center;
    padding: 9px 14px 8px;
  }

  .voice-button {
    display: grid;
    align-content: center;
    height: 40px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 14px;
    background: rgba(255,255,255,.07);
    color: #e3e8ee;
    text-align: left;
    padding: 0 12px;
  }

  .voice-button span { font-size: 11px; font-weight: 760; }
  .voice-button b { color: #8f98a4; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
  .voice-button.armed {
    border-color: rgba(98, 240, 162, .35);
    background: rgba(98, 240, 162, .12);
    color: #fff;
  }

  .small-note {
    display: block;
    min-width: 0;
    color: #9da6b2;
    font: 700 9px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .transcript {
    margin: 0 14px;
    color: #fff;
    padding: 10px;
    border-radius: 14px;
    background: rgba(0,0,0,.3);
    border: 1px solid rgba(255,255,255,.1);
    min-height: 22px;
    font-size: 11px;
  }

  nav {
    display: flex;
    gap: 8px;
    padding: 8px 14px 10px;
  }

  nav button {
    flex: 1;
    display: grid;
    align-content: center;
    height: 42px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 15px;
    background: rgba(255,255,255,.06);
    color: #e1e7ee;
    text-align: left;
    padding: 0 11px;
  }

  nav button span { font-size: 11px; font-weight: 760; }
  nav button b {
    margin-top: 2px;
    color: #87909b;
    font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }

  .proposal-list {
    margin: 0 14px 10px;
    border-top: 1px solid rgba(255,255,255,.08);
    padding-top: 7px;
  }

  .proposal-list > p {
    margin: 0 0 5px;
    color: #78818c;
    font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }

  .proposal-list article {
    display: grid;
    gap: 6px;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    margin: 5px 0;
    padding: 5px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,.08);
    background: rgba(255,255,255,.04);
  }

  .proposal-list b {
    color: #a8b0ba;
    font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace;
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
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 8px;
    background: rgba(255,255,255,.07);
    color: #d9dfe6;
    font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }

  .proposal-list button.danger {
    color: #ffd1cc;
    border-color: #5a2f35;
    background: #2b1516;
  }

  .voice-meta {
    margin: 0 14px;
    padding: 8px 0 7px;
    border-top: 1px solid rgba(255,255,255,.08);
    color: #87909b;
    font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }

  .voice-meta p { margin: 0 0 3px; }
  .voice-meta small { color: #a4acb6; }

  .activity {
    margin: 0 14px;
    padding-top: 8px;
    border-top: 1px solid rgba(255,255,255,.08);
  }

  .activity > p {
    margin: 0 0 5px;
    color: #78818c;
    font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }

  .activity article {
    display: grid;
    grid-template-columns: 7px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
  }

  .activity i { width: 7px; height: 7px; }

  .activity span {
    overflow: hidden;
    color: #d1d6dc;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity b {
    color: #77808b;
    font: 700 7px ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }

  .error { margin: 6px 14px; color: #ff7d72; font-size: 9px; }
  .message { margin: 6px 14px; color: #9aa0a6; font-size: 9px; }

  @media (prefers-reduced-motion: no-preference) {
    .orbital-status { animation: proof-ring 6s linear infinite; }
    .orbital-status span { animation: proof-pulse 1800ms ease-in-out infinite; }
  }

  @keyframes proof-ring {
    to { transform: rotate(360deg); }
  }

  @keyframes proof-pulse {
    0%, 100% { transform: scale(.82); opacity: .72; }
    50% { transform: scale(1); opacity: 1; }
  }
</style>
