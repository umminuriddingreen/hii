<script lang="ts">
  import { onMount } from 'svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  type Note = { id: string; x: number; y: number; text: string; tone: number };
  const storageKey = 'hii.remote.workspace.v1';
  const tones = ['#fff7ad', '#dff6ff', '#e9e1ff', '#e3f7df'];
  let notes: Note[] = [];
  let selected = '';
  let drag: { id: string; offsetX: number; offsetY: number } | null = null;
  let canvas: HTMLElement;

  onMount(() => {
    try { notes = JSON.parse(localStorage.getItem(storageKey) || '[]') as Note[]; } catch { notes = []; }
  });

  function save(next = notes) {
    notes = next;
    localStorage.setItem(storageKey, JSON.stringify(notes));
  }

  function addNote(x = 34, y = 110) {
    const id = crypto.randomUUID();
    save([...notes, { id, x, y, text: 'Tap to write…', tone: notes.length % tones.length }]);
    selected = id;
  }

  function beginDrag(event: PointerEvent, note: Note) {
    const target = event.target as HTMLElement;
    if (target.closest('textarea,button')) return;
    const rect = canvas.getBoundingClientRect();
    drag = { id: note.id, offsetX: event.clientX - rect.left - note.x, offsetY: event.clientY - rect.top - note.y };
    selected = note.id;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent) {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.width - 196, event.clientX - rect.left - drag.offsetX));
    const y = Math.max(72, Math.min(rect.height - 180, event.clientY - rect.top - drag.offsetY));
    notes = notes.map((note) => note.id === drag?.id ? { ...note, x, y } : note);
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    save();
  }

  function clearWorkspace() {
    if (notes.length && confirm('Clear this phone’s remote workspace?')) save([]);
  }
</script>

<svelte:head><title>HII remote · blank workspace</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<main bind:this={canvas} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag}>
  <header>
    <div class="brand"><HiiLogo title="HII" /><span>REMOTE / BLANK WORKSPACE</span></div>
    <div class="actions">
      <button class="add" onclick={() => addNote()}>+ note</button>
      <button class="clear" onclick={clearWorkspace}>clear</button>
      <form method="POST" action="/remote/logout"><button class="logout">log out</button></form>
    </div>
  </header>

  {#if !notes.length}
    <button class="empty" onclick={() => addNote(34, 132)}>
      <strong>Blank workspace</strong>
      <span>Tap to add the first thought.</span>
    </button>
  {/if}

  {#each notes as note (note.id)}
    <article
      class:selected={selected === note.id}
      style={`left:${note.x}px;top:${note.y}px;background:${tones[note.tone]}`}
      onpointerdown={(event) => beginDrag(event, note)}
    >
      <div class="grip"><span>NOTE</span><button aria-label="Delete note" onclick={() => save(notes.filter((item) => item.id !== note.id))}>×</button></div>
      <textarea
        aria-label="Workspace note"
        value={note.text}
        onfocus={() => selected = note.id}
        oninput={(event) => {
          note.text = (event.currentTarget as HTMLTextAreaElement).value;
          save([...notes]);
        }}
      ></textarea>
      <div class="tones" aria-label="Note color">
        {#each tones as tone, index}<button aria-label={`Color ${index + 1}`} style={`background:${tone}`} onclick={() => { note.tone = index; save([...notes]); }}></button>{/each}
      </div>
    </article>
  {/each}

  <footer><span>browser-only event canvas</span><span>no Mac · file · agent access</span></footer>
</main>

<style>
  :global(body){margin:0;overflow:hidden;background:#fbfbf7;color:#0b0b0b;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
  main{position:relative;width:100vw;height:100svh;overflow:hidden;touch-action:none;background-image:radial-gradient(#d1d1ca 1px,transparent 1px);background-size:22px 22px}
  header{position:absolute;z-index:20;inset:0 0 auto;min-height:62px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:rgba(255,255,255,.9);border-bottom:1px solid #d8d8d1;backdrop-filter:blur(16px)}
  .brand{display:flex;align-items:center;gap:10px;min-width:0}.brand span{font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.09em;white-space:nowrap}
  :global(.hii-wordmark){font-size:30px;color:#146cff}
  .actions{display:flex;align-items:center;gap:6px}.actions form{display:flex}.actions button{border:1px solid #c9c9c2;background:white;padding:9px 10px;font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em}.actions .add{background:#0b0b0b;color:white;border-color:#0b0b0b}.actions .clear,.actions .logout{display:none}
  .empty{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(78vw,340px);padding:32px;border:1px dashed #96968e;background:rgba(255,255,255,.82);display:grid;gap:8px;text-align:left}.empty strong{font-size:28px;letter-spacing:-.04em}.empty span{color:#666}
  article{position:absolute;width:188px;height:168px;box-sizing:border-box;border:1px solid rgba(0,0,0,.18);box-shadow:0 10px 28px rgba(0,0,0,.09);display:grid;grid-template-rows:32px 1fr 28px;touch-action:none}article.selected{outline:3px solid rgba(20,108,255,.3);border-color:#146cff}
  .grip{display:flex;align-items:center;justify-content:space-between;padding:0 8px;border-bottom:1px solid rgba(0,0,0,.12);cursor:grab;font:700 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.grip button{border:0;background:transparent;font-size:20px;line-height:1}
  textarea{min-width:0;min-height:0;resize:none;border:0;background:transparent;padding:10px;font:500 16px/1.3 ui-sans-serif,-apple-system,sans-serif;touch-action:auto}textarea:focus{outline:none}
  .tones{display:flex;gap:7px;align-items:center;padding:0 9px}.tones button{width:13px;height:13px;border:1px solid rgba(0,0,0,.25);border-radius:50%;padding:0}
  footer{position:absolute;z-index:10;inset:auto 12px 10px;display:flex;justify-content:space-between;gap:8px;color:#74746e;font:700 8px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;pointer-events:none}
  @media(min-width:720px){.actions .clear,.actions .logout{display:block}header{padding-inline:22px}.brand span{font-size:10px}article{width:220px;height:190px}.empty{padding:40px}.actions button{padding:10px 13px}}
</style>
