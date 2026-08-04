<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import EcosystemNav from '$lib/components/EcosystemNav.svelte';

  type Snapshot = { image:string; title:string; url:string; text:string; selection:string; width:number; height:number };
  type Capture = { id:string; title:string; url:string; selection:string; excerpt:string; contentHash:string; createdAt:string };
  type BrowserCommand =
    | { type:'navigate'; url:string }
    | { type:'back'|'forward'|'reload' }
    | { type:'click'; x:number; y:number }
    | { type:'scroll'; deltaY:number };

  let sessionId = '';
  let address = '';
  let snapshot:Snapshot|null = null;
  let captures:Capture[] = [];
  let projectId = 'default';
  let viewport:HTMLButtonElement;
  let working = false;
  let message = 'Starting local HII Browser…';
  let captureMessage = '';

  const normalize = (value:string) => /^https?:\/\//i.test(value)
    ? value
    : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)
      ? `https://${value}`
      : `https://www.google.com/search?q=${encodeURIComponent(value)}`;

  async function loadCaptures(){
    const response=await fetch('/api/ecosystem?mode=captures&limit=20');
    if(response.ok)captures=(await response.json()).captures||[];
  }

  async function send(command:BrowserCommand){
    if(!sessionId)return;
    working=true;message=command.type==='navigate'?'Opening…':'Working…';captureMessage='';
    try{
      const response=await fetch('/api/browser/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:sessionId,command})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Browser command failed.');
      snapshot=data;address=data.url||address;message='';
    }catch(error){message=error instanceof Error?error.message:'Browser command failed.'}
    finally{working=false}
  }

  function navigate(){const value=address.trim();if(value)void send({type:'navigate',url:normalize(value)})}

  function clickPage(event:MouseEvent){
    if(!snapshot||!viewport)return;
    const rect=viewport.getBoundingClientRect();
    void send({type:'click',x:(event.clientX-rect.left)*snapshot.width/rect.width,y:(event.clientY-rect.top)*snapshot.height/rect.height});
  }

  function wheelPage(event:WheelEvent){event.preventDefault();void send({type:'scroll',deltaY:event.deltaY})}

  async function capture(selectionOnly=false){
    if(!snapshot)return;
    if(selectionOnly&&!snapshot.selection){captureMessage='Select text in the page first, then refresh the snapshot.';return}
    const response=await fetch('/api/ecosystem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      action:'capture',projectId,url:snapshot.url,title:snapshot.title,selection:selectionOnly?snapshot.selection:'',excerpt:selectionOnly?'':snapshot.text,source:'hii-browser'
    })});
    const data=await response.json();
    if(!response.ok){captureMessage=data.error||'Capture failed.';return}
    captureMessage=selectionOnly?'Selection captured locally.':'Page captured locally.';
    await loadCaptures();
  }

  onMount(()=>{
    sessionId=`browser-${crypto.randomUUID()}`;
    void loadCaptures();
    address='https://www.google.com';
    void send({type:'navigate',url:address});
  });

  onDestroy(()=>{if(sessionId)void fetch(`/api/browser/session?id=${encodeURIComponent(sessionId)}`,{method:'DELETE',keepalive:true})});
</script>

<svelte:head><title>Browser — HII</title></svelte:head>

<main class="browser-mode">
  <header class="mode-header">
    <div><p>HII / information retrieval</p><h1>Browser</h1></div>
    <EcosystemNav current="browser" />
  </header>

  <section class="browser-shell">
    <form class="toolbar" on:submit|preventDefault={navigate}>
      <button type="button" on:click={()=>void send({type:'back'})} aria-label="Back">←</button>
      <button type="button" on:click={()=>void send({type:'forward'})} aria-label="Forward">→</button>
      <button type="button" on:click={()=>void send({type:'reload'})} aria-label="Reload">↻</button>
      <input bind:value={address} aria-label="Address or search" spellcheck="false" />
      <button type="submit" disabled={working}>Go</button>
    </form>
    <div class="page-and-context">
      <button bind:this={viewport} class="page" on:click={clickPage} on:wheel={wheelPage} aria-label="Interact with the rendered page">
        {#if snapshot}<img src={snapshot.image} alt={snapshot.title||snapshot.url} draggable="false" />{:else}<span>{message}</span>{/if}
      </button>
      <aside>
        <p class="eyebrow">Source-linked context</p>
        <h2>{snapshot?.title||'Open a page'}</h2>
        <p class="url">{snapshot?.url||'Local, temporary browser session'}</p>
        <label>Project<input bind:value={projectId} maxlength="64" /></label>
        <div class="capture-actions">
          <button disabled={!snapshot} on:click={()=>void capture(false)}>Capture page</button>
          <button disabled={!snapshot?.selection} on:click={()=>void capture(true)}>Capture selection</button>
        </div>
        <p class="policy">Captures stay local. External model delivery remains a separate reviewed action.</p>
        {#if captureMessage}<p class="message">{captureMessage}</p>{/if}
        <div class="recent">
          <p class="eyebrow">Recent captures</p>
          {#each captures.slice(0,6) as item}
            <article><strong>{item.title}</strong><span>{item.selection?'selection':'page'} · {item.contentHash.slice(0,10)}</span><a href={`/create?capture=${encodeURIComponent(item.id)}`}>Use in Create →</a></article>
          {:else}<p class="empty">Nothing captured yet.</p>{/each}
        </div>
      </aside>
    </div>
  </section>
</main>

<style>
  .browser-mode{min-height:100%;box-sizing:border-box;background:#f4f3ef;padding:28px;color:#16181b}.mode-header{display:flex;align-items:end;justify-content:space-between;gap:24px;max-width:1500px;margin:0 auto 20px}.mode-header p,.eyebrow{margin:0;color:#176bff;font:700 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;text-transform:uppercase}.mode-header h1{margin:6px 0 0;font-size:44px;letter-spacing:-.055em}.browser-shell{max-width:1500px;height:calc(100vh - 150px);min-height:650px;margin:auto;overflow:hidden;border:1px solid #d9d8d3;border-radius:24px;background:#fff;box-shadow:0 24px 80px rgba(30,34,42,.12)}.toolbar{display:grid;grid-template-columns:36px 36px 36px 1fr 54px;gap:7px;padding:12px;border-bottom:1px solid #e7e6e1;background:#fbfbf9}.toolbar button,.toolbar input{height:36px;border:1px solid #dfded9;border-radius:10px;background:white}.toolbar input{padding:0 13px;outline:none}.toolbar input:focus{border-color:#176bff}.page-and-context{display:grid;grid-template-columns:minmax(0,1fr) 320px;height:calc(100% - 61px)}.page{display:grid;min-width:0;place-items:start center;overflow:hidden;border:0;background:#202124;padding:0;color:#888}.page img{width:100%;height:100%;object-fit:contain;object-position:top}.page span{align-self:center;font:11px ui-monospace,monospace}aside{overflow:auto;border-left:1px solid #e7e6e1;padding:24px}aside h2{margin:12px 0 6px;font-size:24px;line-height:1.05;letter-spacing:-.035em}.url{overflow:hidden;color:#85888c;font:10px/1.4 ui-monospace,monospace;text-overflow:ellipsis;white-space:nowrap}label{display:grid;gap:7px;margin-top:24px;color:#777;font:700 9px ui-monospace,monospace;text-transform:uppercase}label input{height:38px;border:1px solid #ddd;border-radius:10px;padding:0 11px}.capture-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.capture-actions button{min-height:42px;border:0;border-radius:12px;background:#111317;color:#fff;font-size:12px}.capture-actions button:last-child{background:#176bff}.capture-actions button:disabled{opacity:.35}.policy,.message,.empty{font-size:11px;line-height:1.55;color:#85888c}.message{color:#176bff}.recent{margin-top:28px}.recent article{display:grid;gap:4px;padding:12px 0;border-bottom:1px solid #eee}.recent strong{font-size:12px}.recent span{color:#999;font:9px ui-monospace,monospace}.recent a{color:#176bff;font:9px ui-monospace,monospace;text-decoration:none}@media(max-width:900px){.page-and-context{grid-template-columns:1fr}.page{min-height:480px}aside{border-left:0;border-top:1px solid #eee}.browser-shell{height:auto}.mode-header{align-items:start;flex-direction:column}}
</style>
