<script lang="ts">
  import { onMount } from 'svelte';

  let expanded = true;
  let intent = '';
  let busy = false;
  let error = '';
  let summary:any = null;
  let native = false;
  let input:HTMLInputElement;

  async function refresh(){
    try{const response=await fetch('/api/ecosystem?mode=summary');if(response.ok)summary=await response.json()}catch{/* next poll retries */}
  }

  async function setExpanded(value:boolean){
    expanded=value;error='';
    if(native){
      const {invoke}=await import('@tauri-apps/api/core');
      await invoke('set_notch_expanded',{expanded:value}).catch(()=>{});
    }
    if(value)requestAnimationFrame(()=>input?.focus());
  }

  async function openMode(route:'/browser'|'/create'|'/workspace'){
    if(native){
      const {invoke}=await import('@tauri-apps/api/core');
      await invoke('open_hii_mode',{route});
      await setExpanded(false);
    }else{location.href=route}
  }

  async function run(){
    const goal=intent.trim();if(!goal||busy||!native)return;
    busy=true;error='';
    try{
      const {invoke}=await import('@tauri-apps/api/core');
      const proofRef=await invoke<string>('run_cursor_intent',{goal});
      await fetch('/api/ecosystem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'event',mode:'notch',projectId:'default',status:'running',summary:goal,object:{kind:'run',id:proofRef.split('/').at(-1)?.replace(/\.log$/,'')||crypto.randomUUID()},proofRefs:[proofRef]})});
      intent='';await refresh();await setExpanded(false);
    }catch(cause){error=cause instanceof Error?cause.message:String(cause)}finally{busy=false}
  }

  function keydown(event:KeyboardEvent){
    if(event.key==='Escape'){event.preventDefault();void setExpanded(false)}
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void run()}
  }

  onMount(()=>{
    let timer:ReturnType<typeof setInterval>;let stops:Array<()=>void>=[];void refresh();timer=setInterval(()=>void refresh(),2500);
    void import('@tauri-apps/api/core').then(async core=>{
      native=core.isTauri();if(!native)return;
      expanded=false;
      const {listen}=await import('@tauri-apps/api/event');
      stops=await Promise.all([
        listen('hii://notch-opened',()=>void setExpanded(true)),
        listen('hii://cursor-bar-opened',()=>void setExpanded(true))
      ]);
      await setExpanded(false);
    }).catch(()=>{native=false;expanded=true});
    return()=>{clearInterval(timer);stops.forEach(stop=>stop())}
  });
</script>

<svelte:head><title>Notch — HII</title></svelte:head>

<main class:expanded class="notch-shell">
  {#if !expanded}
    <button class="collapsed" on:click={()=>void setExpanded(true)} aria-label="Open HII Notch">
      <i class:active={Boolean(summary?.active)}></i>
      <strong>hii</strong>
      <span>{summary?.active?.summary||summary?.recent?.[0]?.summary||'Notch'}</span>
      <b>{summary?.active?.status||'ready'}</b>
    </button>
  {:else}
    <section class="expanded-panel">
      <header><div><i class:active={Boolean(summary?.active)}></i><strong>Notch</strong><span>{summary?.active?.status||'local'}</span></div><button on:click={()=>void setExpanded(false)} aria-label="Collapse Notch">−</button></header>
      <form on:submit|preventDefault={run}>
        <input bind:this={input} bind:value={intent} on:keydown={keydown} disabled={busy||!native} placeholder={native?(busy?'Starting verified work…':'What do you want to happen?'):'Open the HII desktop app to run work'} aria-label="Tell HII what you want to happen" />
        <button disabled={!intent.trim()||busy||!native}>↵</button>
      </form>
      <nav><button on:click={()=>void openMode('/browser')}>Browser</button><button on:click={()=>void openMode('/create')}>Create</button><button on:click={()=>void openMode('/workspace')}>Workspace</button></nav>
      <div class="activity">
        <p>Recent system state</p>
        {#each summary?.recent?.slice(0,4)||[] as event}<article><i class:running={['queued','running'].includes(event.status)}></i><span>{event.summary}</span><b>{event.status}</b></article>{:else}<article><i></i><span>No captured work yet.</span><b>ready</b></article>{/each}
      </div>
      {#if error}<p class="error">{error}</p>{/if}
    </section>
  {/if}
</main>

<style>
  :global(html),:global(body){width:100%;height:100%;margin:0;overflow:hidden;background:transparent!important}.notch-shell{width:100%;height:100%;box-sizing:border-box;padding:0 8px 8px;color:white;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}.collapsed{display:grid;grid-template-columns:8px auto minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;height:44px;border:0;border-radius:0 0 18px 18px;background:#090a0b;color:white;padding:0 15px;box-shadow:0 10px 32px rgba(0,0,0,.3);text-align:left}.collapsed i,header i,.activity i{width:7px;height:7px;border-radius:50%;background:#65686d}.collapsed i.active,header i.active,.activity i.running{background:#58e47e;box-shadow:0 0 12px #58e47e}.collapsed strong{font-size:13px;letter-spacing:-.04em}.collapsed span{overflow:hidden;color:#b4b7bc;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.collapsed b{color:#74787e;font:8px ui-monospace,monospace;text-transform:uppercase}.expanded-panel{height:100%;box-sizing:border-box;overflow:hidden;border-radius:0 0 24px 24px;background:rgba(9,10,11,.97);box-shadow:0 18px 55px rgba(0,0,0,.38);backdrop-filter:blur(24px)}header{display:flex;align-items:center;justify-content:space-between;padding:14px 17px 10px}header>div{display:flex;align-items:center;gap:9px}header strong{font-size:14px}header span{color:#6f7379;font:8px ui-monospace,monospace;text-transform:uppercase}header button{border:0;background:transparent;color:#777;font-size:16px}form{display:flex;align-items:center;margin:0 14px;border:1px solid #303238;border-radius:14px;background:#15171a;padding:4px}form input{min-width:0;flex:1;height:43px;border:0;background:transparent;color:white;padding:0 11px;outline:0;font-size:14px}form input::placeholder{color:#686c72}form button{width:36px;height:34px;border:0;border-radius:10px;background:#176bff;color:#fff}form button:disabled{opacity:.35}nav{display:flex;gap:7px;padding:10px 14px}nav button{flex:1;height:31px;border:1px solid #2b2e33;border-radius:9px;background:#15171a;color:#b9bcc1;font:8px ui-monospace,monospace;text-transform:uppercase}.activity{margin:0 14px;padding-top:8px;border-top:1px solid #24262a}.activity>p{margin:0 0 5px;color:#62666c;font:8px ui-monospace,monospace;text-transform:uppercase}.activity article{display:grid;grid-template-columns:7px minmax(0,1fr) auto;align-items:center;gap:8px;padding:5px 0}.activity span{overflow:hidden;color:#c5c7ca;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.activity b{color:#666a70;font:7px ui-monospace,monospace;text-transform:uppercase}.error{margin:6px 14px;color:#ff7d72;font-size:9px}
</style>
