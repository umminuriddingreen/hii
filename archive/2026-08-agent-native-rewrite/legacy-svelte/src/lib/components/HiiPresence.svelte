<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import WorkspacePage from '$lib/components/workspace/WorkspacePage.svelte';
  import { voiceInterpret, type VoiceApiRuntimeState } from '$lib/voice/client';
  import type { PageData } from '../../routes/$types';

  export let data: PageData;
  type Mode = 'canvas' | 'unicode' | 'text';
  let mode: Mode = 'canvas';
  let transcript = '';
  let reply = 'Speak, type, or place context on the canvas.';
  let listening = false;
  let thinking = false;
  let error = '';
  let recognition: any = null;
  let finalText = '';
  let interimText = '';

  $: signal = listening ? 'LISTENING' : thinking ? 'INTERPRETING' : error ? 'ATTENTION' : 'READY';
  $: visualText = transcript || interimText || 'waiting for intent';

  function clean(value: string) { return value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim(); }
  async function submit(value: string) {
    const utterance = clean(value);
    if (!utterance || thinking) return;
    transcript = utterance;
    thinking = true;
    error = '';
    try {
      const state = await voiceInterpret({ utterance, requestedBy: 'hii-presence' }) as VoiceApiRuntimeState;
      reply = typeof state.message === 'string' ? state.message : 'Intent recorded.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Voice intent could not be interpreted.';
      reply = 'No state was changed.';
    } finally { thinking = false; }
  }
  function toggleListening() {
    if (listening) { recognition?.stop(); return; }
    const ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!ctor) { error = 'Speech recognition is unavailable in this browser. Type instead.'; return; }
    recognition = new ctor(); recognition.continuous = false; recognition.interimResults = true; recognition.lang = 'en-US';
    recognition.onstart = () => { listening = true; error = ''; finalText = ''; interimText = ''; };
    recognition.onresult = (event: any) => {
      let final = ''; let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const value = String(event.results[i][0]?.transcript || '');
        if (event.results[i].isFinal) final += `${value} `; else interim += `${value} `;
      }
      finalText = clean(`${finalText} ${final}`); interimText = clean(interim);
    };
    recognition.onerror = (event: any) => { error = `Voice input: ${String(event?.error || 'unknown error')}`; };
    recognition.onend = () => { listening = false; const value = clean(`${finalText} ${interimText}`); interimText = ''; if (value) void submit(value); };
    recognition.start();
  }
  function keydown(event: KeyboardEvent) { if (event.key === 'Escape') { interimText = ''; recognition?.stop(); } }
  onMount(() => window.addEventListener('keydown', keydown));
  onDestroy(() => { window.removeEventListener('keydown', keydown); recognition?.stop(); });
</script>

<main class="presence" data-mode={mode}>
  <div class="mode-bar" data-workspace-ui>
    <strong>HII</strong><span>local signal field</span>
    <div><button class:active={mode==='canvas'} on:click={() => mode='canvas'}>Canvas</button><button class:active={mode==='unicode'} on:click={() => mode='unicode'}>Unicode</button><button class:active={mode==='text'} on:click={() => mode='text'}>Text</button></div>
  </div>
  {#if mode === 'canvas'}
    <WorkspacePage {data} />
  {:else if mode === 'unicode'}
    <section class="unicode-stage" aria-label="HII Unicode presence">
      <pre aria-live="polite">╭─ HII / LIVE CONTEXT ───────────────────────────────╮
│ STATE     {signal.padEnd(39)}│
│ INTENT    {visualText.slice(0, 39).padEnd(39)}│
│ INPUT     {visualText.slice(0, 39).padEnd(39)}│
│ RESPONSE  {reply.slice(0, 39).padEnd(39)}│
├─ PIPE ─────────────────────────────────────────────┤
│ voice → interpreted intent → local proposal → proof │
│ canvas ↔ source cards ↔ timeline ↔ agent context    │
╰─────────────────────────────────────────────────────╯</pre>
      <p>One live representation of your current intent. Nothing is sent or executed without the existing HII boundary.</p>
    </section>
  {:else}
    <section class="text-stage" aria-label="HII persistent intent text">
      <div><span>HII / INTENT STREAM</span><small>voice and typing become the same clean, local record</small></div>
      <textarea bind:value={transcript} placeholder="State what you want to make, understand, change, or remember…" aria-label="Intent text" on:keydown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(transcript); } }}></textarea>
      <footer><span>{thinking ? 'interpreting intent…' : '⌘↵ to stage intent'}</span><button on:click={() => void submit(transcript)} disabled={thinking || !transcript.trim()}>Stage intent →</button></footer>
      <p>{reply}</p>
    </section>
  {/if}
  <section class="signal-box" data-workspace-ui class:listening class:thinking aria-label="Voice interaction">
    <div class="signal-head"><span>{signal}</span><i></i><small>browser speech may use a platform service</small></div>
    <p>{listening ? (interimText || 'Listening…') : transcript || 'Talk to HII'}</p>
    <div class="signal-reply">{reply}</div>
    {#if error}<div class="signal-error">{error}</div>{/if}
    <div class="signal-actions"><button class="mic" on:click={toggleListening}>{listening ? '■ Stop' : '◉ Speak'}</button><input bind:value={transcript} on:keydown={(event) => event.key === 'Enter' && void submit(transcript)} placeholder="or type an intent" /><button on:click={() => void submit(transcript)} disabled={thinking}>→</button></div>
  </section>
</main>

<style>
  .presence{position:fixed;inset:0;background:#fbfbf7;color:#152028;overflow:hidden}.mode-bar{position:fixed;z-index:10020;left:20px;top:18px;display:flex;align-items:center;gap:11px;padding:7px 9px 7px 12px;border:1px solid #17242c22;background:#fbfbf7e8;backdrop-filter:blur(12px);font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.mode-bar strong{font-size:12px;letter-spacing:-.04em}.mode-bar span{color:#637078}.mode-bar div{display:flex;border-left:1px solid #17242c22;padding-left:7px}.mode-bar button,.signal-actions button{border:0;background:transparent;padding:6px 8px;font:inherit;cursor:pointer}.mode-bar button.active{background:#152028;color:#f7fbf9}.unicode-stage{height:100%;display:grid;place-content:center;padding:80px 24px;background:repeating-linear-gradient(0deg,transparent 0 30px,#17242c08 31px),#f8f8f2}.unicode-stage pre{margin:0;border:1px solid #17242c;background:#152028;color:#d9ffe4;padding:22px;max-width:calc(100vw - 40px);overflow:auto;font:clamp(10px,1.4vw,15px)/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:10px 10px 0 #c7f260}.unicode-stage p{max-width:530px;color:#526066;font:13px/1.5 ui-sans-serif,system-ui}.text-stage{height:100%;display:grid;grid-template-rows:auto minmax(220px,45vh) auto auto;align-content:center;gap:12px;max-width:780px;margin:auto;padding:80px 28px}.text-stage>div{display:flex;justify-content:space-between;gap:15px;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}.text-stage small{color:#67757b;font-size:9px}.text-stage textarea{resize:none;border:1px solid #17242c;background:#fff;padding:28px;font:clamp(19px,3vw,36px)/1.12 ui-sans-serif,system-ui;letter-spacing:-.04em;outline:none}.text-stage textarea:focus{box-shadow:8px 8px 0 #c7f260}.text-stage footer{display:flex;justify-content:space-between;align-items:center;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#67757b}.text-stage footer button{border:0;background:#152028;color:#fff;padding:11px 15px;font:inherit;cursor:pointer}.text-stage footer button:disabled{opacity:.45}.text-stage p{margin:0;color:#526066;font:14px/1.5 ui-sans-serif,system-ui}.signal-box{position:fixed;z-index:10021;right:20px;bottom:20px;width:min(430px,calc(100vw - 40px));border:1px solid #152028;background:#fbfbf7;box-shadow:7px 7px 0 #152028;padding:12px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.signal-box.listening{box-shadow:7px 7px 0 #ef755f}.signal-box.thinking{box-shadow:7px 7px 0 #c7f260}.signal-head{display:flex;align-items:center;gap:8px;color:#526066;font-size:9px;letter-spacing:.1em}.signal-head i{width:7px;height:7px;background:#42a86b;border-radius:50%}.signal-head small{margin-left:auto;font-size:8px;letter-spacing:0;color:#78838a}.signal-box p{margin:13px 0 7px;font-size:15px;color:#152028}.signal-reply{min-height:31px;border-top:1px solid #17242c22;padding-top:7px;color:#526066}.signal-error{margin-top:6px;color:#bd3f31}.signal-actions{display:flex;gap:5px;margin-top:10px}.signal-actions .mic{background:#152028;color:#fff}.signal-actions input{min-width:0;flex:1;border:1px solid #17242c33;background:#fff;padding:7px;font:inherit;outline:none}.signal-actions input:focus{border-color:#152028}.signal-actions button:disabled{opacity:.45}@media(max-width:640px){.mode-bar{left:10px;top:10px}.signal-box{right:12px;bottom:12px;width:calc(100vw - 24px)}.signal-head small{display:none}.text-stage{padding:70px 18px}.text-stage>div small{display:none}}
</style>
