  <script lang="ts">
  import { onMount, tick } from 'svelte';
  import TerminalPane from '$lib/components/TerminalPane.svelte';
  import BrowserPane from '$lib/components/workspace/BrowserPane.svelte';
  import ChatPane from '$lib/components/workspace/ChatPane.svelte';
  import ExplorerPane from '$lib/components/workspace/ExplorerPane.svelte';
  import DocumentPane from '$lib/components/workspace/DocumentPane.svelte';
  import CadPane from '$lib/components/workspace/CadPane.svelte';
  import IntentPane from '$lib/components/workspace/IntentPane.svelte';
  import SpatialRunPane from '$lib/components/workspace/SpatialRunPane.svelte';
  import SurfacePane from '$lib/components/workspace/SurfacePane.svelte';
  import StaticNode from '$lib/components/workspace/StaticNode.svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';
  import type { WorkspaceDoc, WorkspaceNode, WorkspaceNodeType } from '@/lib/workspace/types';
  import { makeNode, seedFor, seedFromFile, seedFromString, seedsFromDataTransfer, type NodeSeed } from '@/lib/workspace/ingest';
  import { panWorkspaceViewport, zoomWorkspaceViewportAt } from '@/lib/workspace/viewport';

  export let data: { enabled: boolean };
  const surfaceCatalog = [
    { id:'knowledge', title:'Knowledge', path:'/knowledge', capabilityId:'hii.knowledge.workspace', detail:'canonical notes · systems · proof' },
    { id:'activate', title:'Activation', path:'/activate', capabilityId:'hii.agent.workspace_run', detail:'choose agent · approve context · run' },
    { id:'boards', title:'Boards', path:'/boards', capabilityId:'hii.board.task_kanban', detail:'bounded work · owners · blockers' },
    { id:'console', title:'Console', path:'/console', capabilityId:'hii.terminal.observe', detail:'agents · logs · receipts' },
    { id:'dashboard', title:'System', path:'/dashboard', capabilityId:'hii.og.operational_graph', detail:'live status · capabilities · next actions' }
  ];
  let doc:WorkspaceDoc={version:1,revision:0,updatedAt:new Date().toISOString(),viewport:{x:0,y:0,zoom:1},nextZ:1,nodes:[]};
  let ready=false; let loadState:'loading'|'ready'|'recovery'='loading'; let loadError=''; let recoveryPath=''; let saveError='';
  let selected:string|null=null; let omnibar=false; let query=''; let saveTimer:ReturnType<typeof setTimeout>|undefined; let saveInFlight=false; let savePending=false;
  let context:any=null; let board:any[]=[]; let daemon:any=null; let canvas:HTMLElement; let mouse={x:400,y:300};
  let commandInput:HTMLInputElement; let fileInput:HTMLInputElement;
  let composerOpen=false; let composerText=''; let composerInput:HTMLTextAreaElement; let composerAt={x:400,y:280}; let lastSummon=0;
  let ModelPaneComponent:any=null; let modelPanePromise:Promise<void>|null=null; let modelPaneError='';
  $: commands=[
    ...surfaceCatalog.map(item=>['surface',`Open ${item.title}`,item.detail,item.path,item.capabilityId]),
    ['intent','Tell HII what to do','create a bounded workspace intent'],
    ['upload','Upload a file or document','images · PDFs · documents · media'],
    ['canvas-text','New canvas text','lightweight text object'],
    ['note','New note','persistent workspace object'],
    ['terminal','New terminal','zsh · run Claude or Codex'],
    ['browser','New browser','URL or web search'],
    ['chat','New HII chat','local context object'],
    ['explorer','Open workspace explorer','browse available workspace tools'],
    ['context','Pin live system context','git · capabilities · next actions'],
    ['board','Open board object','~/.hii board lanes'],
    ['sound-field','Open South Berkeley sound field','modeled dBA']
  ].filter(item=>`${item[1]} ${item[2]}`.toLowerCase().includes(query.toLowerCase()));

  function ensureModelPane(){if(ModelPaneComponent||modelPanePromise)return;modelPanePromise=import('$lib/components/workspace/ModelPane.svelte').then(module=>{ModelPaneComponent=module.default;modelPaneError=''}).catch(error=>{modelPanePromise=null;modelPaneError=error instanceof Error?error.message:'3D viewer unavailable'})}
  async function load(){
    loadState='loading';loadError='';recoveryPath='';saveError='';
    try{
      const response=await fetch('/api/workspace');
      const result=await response.json().catch(()=>({}));
      if(!response.ok||result.status==='recovery'){
        loadState='recovery';loadError=result.error||'HII could not load this workspace.';recoveryPath=result.recoveryPath||'';return;
      }
      doc=result.workspace;loadState='ready';
      if(doc.nodes.some(node=>node.type==='model'))ensureModelPane();
    }catch(error){
      loadState='recovery';loadError=error instanceof Error?error.message:'HII could not load this workspace.';
    }finally{ready=true;}
  }
  async function saveNow(){
    if(loadState!=='ready')return;
    if(saveInFlight){savePending=true;return;}
    saveInFlight=true;savePending=false;
    const expectedRevision=doc.revision;saveError='';
    try{
      const response=await fetch('/api/workspace',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:doc,expectedRevision})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){saveError=result.error||'HII could not save this workspace.';return;}
      doc={...doc,revision:result.workspace.revision,updatedAt:result.workspace.updatedAt};
    }catch(error){saveError=error instanceof Error?error.message:'HII could not save this workspace.';}
    finally{saveInFlight=false;if(savePending)void saveNow();}
  }
  function persist(){
    if(loadState!=='ready')return;
    if(saveTimer)clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>void saveNow(),500);
  }
  function patch(id:string,patch:Partial<WorkspaceNode>){doc={...doc,nodes:doc.nodes.map(n=>n.id===id?{...n,...patch,updatedAt:new Date().toISOString()}:n)};persist();}
  function addSeeds(seeds:NodeSeed[],at:{x:number;y:number}){if(seeds.some(seed=>seed.type==='model'))ensureModelPane();for(const [index,seed] of seeds.entries()){const node=makeNode(seed,at.x+index*28,at.y+index*28,++doc.nextZ);doc={...doc,nodes:[...doc.nodes,node]};selected=node.id}persist();}
  function spawn(type:string,payload:Record<string,unknown>={}){const seed=seedFor(type as WorkspaceNodeType,type==='browser'?{url:'https://duckduckgo.com',...payload}:type==='terminal'?{sessionId:crypto.randomUUID(),...payload}:payload);const center={x:(-doc.viewport.x+innerWidth/2)/doc.viewport.zoom,y:(-doc.viewport.y+innerHeight/2)/doc.viewport.zoom};addSeeds([seed],{x:center.x-seed.w/2,y:center.y-seed.h/2});omnibar=false;query='';if(type==='context')void refreshContext();if(type==='board')void refreshBoard();}
  function workspacePoint(clientX:number,clientY:number){return{x:(clientX-doc.viewport.x)/doc.viewport.zoom,y:(clientY-doc.viewport.y)/doc.viewport.zoom}}
  async function summonComposer(at?:{x:number;y:number}){const now=Date.now();if(now-lastSummon<180)return;lastSummon=now;composerAt=at||workspacePoint(innerWidth/2,innerHeight/2);composerOpen=true;omnibar=false;await tick();composerInput?.focus();}
  function createSpatialRun(intent:string,at:{x:number;y:number},parentId?:string){const title=intent.length>44?`${intent.slice(0,44)}…`:intent;let z=doc.nextZ;const intentSeed=seedFor('intent',{title:'your intent',text:intent,parentId}),intentNode=makeNode(intentSeed,at.x,at.y,++z),runSeed=seedFor('run',{title, prompt:intent,parentId:intentNode.id,autoStart:true}),runNode=makeNode(runSeed,at.x,at.y+intentSeed.h+20,++z);doc={...doc,nextZ:z,nodes:[...doc.nodes,intentNode,runNode]};selected=runNode.id;persist();}
  function submitIntent(){const intent=composerText.trim();if(!intent)return;const width=seedFor('intent').w;createSpatialRun(intent,{x:composerAt.x-width/2,y:composerAt.y-72});composerText='';composerOpen=false;}
  async function openCommands(){omnibar=true;query='';await tick();commandInput?.focus();}
  function runCommand(command:string[]){if(command[0]==='surface')spawn('surface',{title:command[1].replace('Open ',''),path:command[3],capabilityId:command[4]});else if(command[0]==='intent')void summonComposer();else if(command[0]==='upload'){omnibar=false;fileInput?.click()}else spawn(command[0]);}
  function followUp(node:WorkspaceNode,text:string){createSpatialRun(text,{x:node.x+node.w+48,y:node.y},node.id)}
  function openExplorer(event:MouseEvent){if(event.target!==canvas)return;const at=workspacePoint(event.clientX,event.clientY),seed=seedFor('explorer'),topLeft=workspacePoint(24,52),bottomRight=workspacePoint(innerWidth-24,innerHeight-72),x=Math.max(topLeft.x,Math.min(at.x-seed.w/2,bottomRight.x-seed.w)),y=Math.max(topLeft.y,Math.min(at.y-seed.h/2,bottomRight.y-seed.h));addSeeds([seed],{x,y});}
  function openSurface(id:string){const item=surfaceCatalog.find(candidate=>candidate.id===id);if(item)spawn('surface',{surface:item.id,title:item.title,path:item.path,capabilityId:item.capabilityId});}
  function close(id:string){doc={...doc,nodes:doc.nodes.filter(n=>n.id!==id)};selected=null;persist();}
  function select(node:WorkspaceNode){selected=node.id;if(node.z<doc.nextZ)patch(node.id,{z:++doc.nextZ});}
  function drag(event:PointerEvent,node:WorkspaceNode){if((event.target as HTMLElement).closest('button,input,textarea,iframe,a,.scroll,.xterm'))return;event.preventDefault();select(node);const sx=event.clientX,sy=event.clientY,ox=node.x,oy=node.y;const move=(e:PointerEvent)=>patch(node.id,{x:ox+(e.clientX-sx)/doc.viewport.zoom,y:oy+(e.clientY-sy)/doc.viewport.zoom});const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up)};addEventListener('pointermove',move);addEventListener('pointerup',up);}
  function resize(event:PointerEvent,node:WorkspaceNode){event.preventDefault();event.stopPropagation();const sx=event.clientX,sy=event.clientY,ow=node.w,oh=node.h;const move=(e:PointerEvent)=>patch(node.id,{w:Math.max(140,ow+(e.clientX-sx)/doc.viewport.zoom),h:Math.max(80,oh+(e.clientY-sy)/doc.viewport.zoom)});const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up)};addEventListener('pointermove',move);addEventListener('pointerup',up);}
  function pan(event:PointerEvent){if(event.target!==canvas)return;const sx=event.clientX,sy=event.clientY,ox=doc.viewport.x,oy=doc.viewport.y;const move=(e:PointerEvent)=>doc={...doc,viewport:{...doc.viewport,x:ox+e.clientX-sx,y:oy+e.clientY-sy}};const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up);persist()};addEventListener('pointermove',move);addEventListener('pointerup',up);}
  function canNestedSurfaceScroll(event:WheelEvent){
    let element=event.target instanceof HTMLElement?event.target:null;
    while(element&&element!==canvas){
      const style=getComputedStyle(element),vertical=/(auto|scroll)/.test(style.overflowY),horizontal=/(auto|scroll)/.test(style.overflowX);
      const canY=vertical&&element.scrollHeight>element.clientHeight&&((event.deltaY<0&&element.scrollTop>0)||(event.deltaY>0&&element.scrollTop+element.clientHeight<element.scrollHeight-1));
      const canX=horizontal&&element.scrollWidth>element.clientWidth&&((event.deltaX<0&&element.scrollLeft>0)||(event.deltaX>0&&element.scrollLeft+element.clientWidth<element.scrollWidth-1));
      if(canX||canY)return true;
      element=element.parentElement;
    }
    return false;
  }
  function trackpad(event:WheelEvent){
    const zooming=event.metaKey||event.ctrlKey;
    if(!zooming&&canNestedSurfaceScroll(event))return;
    event.preventDefault();
    const unit=event.deltaMode===WheelEvent.DOM_DELTA_LINE?16:event.deltaMode===WheelEvent.DOM_DELTA_PAGE?innerHeight:1;
    if(zooming){
      doc={...doc,viewport:zoomWorkspaceViewportAt(doc.viewport,{x:event.clientX,y:event.clientY},event.deltaY*unit)};
    }else{
      const horizontal=event.shiftKey&&event.deltaX===0?event.deltaY: event.deltaX;
      doc={...doc,viewport:panWorkspaceViewport(doc.viewport,horizontal*unit,(event.shiftKey&&event.deltaX===0?0:event.deltaY)*unit)};
    }
    persist();
  }
  async function refreshContext(){try{context=await (await fetch('/api/context')).json()}catch{}}
  async function refreshBoard(){try{board=(await (await fetch('/api/board/tasks')).json()).tasks||[]}catch{}}
  async function refreshDaemon(){try{daemon=await (await fetch('/api/daemon')).json()}catch{}}
  function keydown(event:KeyboardEvent){if(event.altKey&&event.code==='Space'&&!event.repeat){event.preventDefault();void summonComposer();return}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(omnibar)omnibar=false;else void openCommands();}if(event.key==='Escape'){omnibar=false;composerOpen=false;}}
  async function drop(event:DragEvent){event.preventDefault();if(!event.dataTransfer)return;const at={x:(event.clientX-doc.viewport.x)/doc.viewport.zoom,y:(event.clientY-doc.viewport.y)/doc.viewport.zoom};addSeeds(await seedsFromDataTransfer(event.dataTransfer),at)}
  async function addFiles(files:File[]){const seeds=await Promise.all(files.map(seedFromFile));const center={x:(-doc.viewport.x+innerWidth/2)/doc.viewport.zoom,y:(-doc.viewport.y+innerHeight/2)/doc.viewport.zoom};addSeeds(seeds,{x:center.x-190,y:center.y-150})}
  onMount(()=>{let disposed=false;let unlistenSummon:(()=>void)|undefined;load();refreshContext();refreshBoard();refreshDaemon();const move=(e:PointerEvent)=>mouse={x:e.clientX,y:e.clientY};const paste=(e:ClipboardEvent)=>{if((e.target as Element)?.closest?.('input,textarea,[contenteditable]'))return;const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();void addFiles(files);return}const text=e.clipboardData?.getData('text/plain');if(text){const at={x:(mouse.x-doc.viewport.x)/doc.viewport.zoom,y:(mouse.y-doc.viewport.y)/doc.viewport.zoom};addSeeds([seedFromString(text)],at)}};const nativeSummon=()=>void summonComposer();const summonFromUrl=new URLSearchParams(location.search).get('summon')==='1';if(summonFromUrl){history.replaceState(history.state,'',location.pathname);void summonComposer()}void import('@tauri-apps/api/core').then(async(core)=>{if(!core.isTauri())return;const{listen}=await import('@tauri-apps/api/event');const stop=await listen('hii://summon',nativeSummon);if(disposed)stop();else unlistenSummon=stop}).catch(()=>{});window.addEventListener('hii:summon',nativeSummon);window.addEventListener('keydown',keydown);window.addEventListener('pointermove',move);window.addEventListener('paste',paste);return()=>{disposed=true;unlistenSummon?.();window.removeEventListener('hii:summon',nativeSummon);window.removeEventListener('keydown',keydown);window.removeEventListener('pointermove',move);window.removeEventListener('paste',paste)}});
</script>

{#if !data.enabled}<div class="hii-page flex min-h-[60vh] flex-col items-center justify-center gap-3"><p class="hii-kicker">surface off</p><h1 class="hii-page-title">HII is turned off</h1></div>
{:else}<main bind:this={canvas} class="absolute inset-0 touch-none overflow-hidden" on:pointerdown={pan} on:dblclick={openExplorer} on:wheel={trackpad} on:dragover|preventDefault on:drop={drop} style="background:#fff radial-gradient(circle,rgba(23,23,23,.08) 1px,transparent 1px);background-size:32px 32px">
  {#if loadState==='recovery'}
    <section data-workspace-ui class="absolute inset-0 z-[10000] grid place-items-center bg-[#f4f5f7]/95 p-6" aria-labelledby="workspace-recovery-title">
      <div class="w-[min(620px,92vw)] rounded-[28px] border border-amber-950/15 bg-white p-8 shadow-2xl sm:p-10">
        <p class="font-mono text-[9px] font-bold uppercase tracking-[.14em] text-amber-700">Workspace recovery</p>
        <h1 id="workspace-recovery-title" class="mt-3 text-[clamp(36px,6vw,58px)] font-semibold leading-[.95] tracking-[-.055em]">Your workspace was not opened.</h1>
        <p class="mt-5 text-[16px] leading-7 text-neutral-600">{loadError} HII has blocked saving so the original cannot be overwritten.</p>
        {#if recoveryPath}<p class="mt-4 break-all rounded-xl bg-neutral-100 p-3 font-mono text-[10px] leading-5 text-neutral-600">Preserved at {recoveryPath}</p>{/if}
        <button class="mt-7 rounded-full bg-neutral-950 px-5 py-3 font-mono text-[10px] uppercase tracking-[.1em] text-white" on:click={()=>void load()}>Try loading again</button>
      </div>
    </section>
  {/if}
  {#if saveError}
    <div data-workspace-ui role="alert" class="absolute left-1/2 top-4 z-[9999] flex w-[min(680px,90vw)] -translate-x-1/2 items-center justify-between gap-4 rounded-2xl border border-red-900/15 bg-white px-4 py-3 shadow-xl">
      <p class="text-[13px] text-red-800"><strong>Workspace not saved.</strong> {saveError}</p>
      <button class="shrink-0 font-mono text-[9px] uppercase underline" on:click={()=>void saveNow()}>Try again</button>
    </div>
  {/if}
  <div class="absolute left-0 top-0 origin-top-left will-change-transform" style={`transform:translate(${doc.viewport.x}px,${doc.viewport.y}px) scale(${doc.viewport.zoom})`}>
    {#each doc.nodes as node (node.id)}<section role="group" aria-label={`${node.type} workspace node`} class="group absolute left-0 top-0 flex flex-col overflow-hidden" on:pointerdown={(event)=>drag(event,node)} style={`transform:translate(${node.x}px,${node.y}px);width:${node.w}px;height:${node.h}px;z-index:${Math.round(node.z)}`}>
      <header class="pointer-events-none absolute right-1 top-1 z-20"><span class="sr-only">{String(node.payload.title||node.type)}</span><button class="pointer-events-auto grid h-6 w-6 place-items-center rounded-full bg-neutral-950/80 text-sm text-white opacity-0 shadow-sm transition-opacity hover:bg-neutral-950 group-hover:opacity-100 focus:opacity-100" on:click={()=>close(node.id)} aria-label="close node">×</button></header>
      <div class="relative min-h-0 flex-1">
        {#if ['note','text','canvas-text','ink','link','file','image','media','html','font'].includes(node.type)}<StaticNode {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} onSize={(size)=>patch(node.id,size)} />
        {:else if node.type==='intent'}<IntentPane {node} />
        {:else if node.type==='run'}<SpatialRunPane {node} onPatch={(next)=>patch(node.id,next)} onFollowUp={(text)=>followUp(node,text)} />
        {:else if node.type==='document'}<DocumentPane {node} />
        {:else if node.type==='cad'}<CadPane {node} />
        {:else if node.type==='model'}{#if ModelPaneComponent}<svelte:component this={ModelPaneComponent} {node} />{:else}<div class="grid h-full place-items-center bg-[#f3f1ec] p-5 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-400">{modelPaneError||'loading 3D viewer…'}</div>{/if}
        {:else if node.type==='terminal'}<TerminalPane sessionId={String(node.payload.sessionId)} cwd={String(node.payload.cwd||'')} />
        {:else if node.type==='browser'}<BrowserPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='explorer'}<ExplorerPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='context'}<div class="scroll h-full overflow-auto p-3.5"><div class="flex justify-between font-mono text-[10px] uppercase text-neutral-400"><span>system context</span><button on:click={refreshContext}>refresh</button></div><div class="mt-3 rounded-md border p-3"><strong class="font-mono text-[11px]">{context?.git?.branch||'reading…'}</strong><p class="font-mono text-[10px] text-neutral-500">{context?.git?.status?.length||0} dirty paths</p></div><h3 class="mt-3 font-mono text-[10px] uppercase text-neutral-400">next</h3>{#each context?.nextActions?.slice(0,4)||[] as action}<p class="mt-1 text-[12px]"><span class="text-[var(--hii-electric-blue)]">{action.track}</span> {action.next}</p>{/each}</div>
        {:else if node.type==='board'}<div class="scroll h-full overflow-auto p-3.5"><div class="flex justify-between font-mono text-[10px] uppercase text-neutral-400"><span>board</span><a href="/boards">open ↗</a></div>{#each ['doing','next','blocked','backlog'] as lane}{#if board.some(task=>task.lane===lane)}<h3 class="mt-3 font-mono text-[10px] uppercase text-neutral-400">{lane}</h3>{#each board.filter(task=>task.lane===lane).slice(0,6) as task}<div class="mt-1.5 rounded-md border p-2 text-[12px]">{task.title}</div>{/each}{/if}{/each}</div>
        {:else if node.type==='surface'}<SurfacePane path={String(node.payload.path||'/')} title={String(node.payload.title||'HII surface')} />
        {:else if node.type==='chat'}<ChatPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='sound-field'}<div class="relative h-full overflow-hidden bg-[#07131c] text-white"><div class="absolute inset-0 opacity-70" style="background:radial-gradient(circle at 65% 55%,#ffce3a 0,transparent 7%),radial-gradient(circle at 45% 40%,#ff6b35 0,transparent 14%),radial-gradient(circle at 50% 50%,#176bff 0,transparent 55%)"></div><div class="relative p-5"><p class="font-mono text-xs text-white/60">MODELED / WEEKDAY / 18:00</p><h2 class="mt-2 text-3xl">South Berkeley Sound Field</h2><p class="mt-3 max-w-sm text-sm text-white/70">A provenance-aware spatial scene. Replace modeled values with calibrated measurements before analysis.</p></div></div>
        {:else}<div class="grid h-full place-items-center p-4 font-mono text-[11px] text-neutral-400">{String(node.payload.text||node.payload.title||node.type)}</div>{/if}
      </div><button type="button" aria-label={`Resize ${node.type} node`} class="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize" on:pointerdown={(event)=>resize(event,node)}></button>
    </section>{/each}
    {#if composerOpen}<section data-workspace-ui class="absolute z-[9999] w-[min(620px,80vw)] -translate-x-1/2 overflow-hidden rounded-2xl border border-neutral-900/10 bg-white/95 shadow-2xl backdrop-blur-xl" style={`left:${composerAt.x}px;top:${composerAt.y}px`}>
      <div class="flex items-start gap-3 p-4">
        <span class="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--hii-electric-blue)] text-sm text-white">✦</span>
        <textarea bind:this={composerInput} bind:value={composerText} rows="3" class="min-h-[76px] flex-1 resize-none bg-transparent text-[22px] font-medium leading-tight outline-none" placeholder="Tell HII what to create, explore, or do…" on:keydown={(event)=>{event.stopPropagation();if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitIntent()}}}></textarea>
      </div>
      <footer class="flex items-center justify-between border-t px-4 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400"><span>direct workspace intent · Shift Enter for a new line</span><button class="rounded-full bg-neutral-950 px-3 py-1.5 text-white disabled:opacity-30" disabled={!composerText.trim()} on:click={submitIntent}>send to HII ↵</button></footer>
    </section>{/if}
  </div>
  {#if ready&&doc.nodes.length===0}
    <section class="absolute inset-0 grid place-items-center p-6" aria-labelledby="empty-workspace-title">
      <div data-workspace-ui class="w-[min(720px,92vw)] rounded-[28px] border border-neutral-900/10 bg-white/94 p-7 shadow-[0_28px_90px_rgba(16,24,40,.13)] backdrop-blur-xl sm:p-10">
        <div class="flex items-center justify-between">
          <HiiLogo />
          <span class="rounded-full bg-[var(--hii-soft-green)] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-emerald-800">local workspace</span>
        </div>
        <p class="mt-12 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--hii-electric-blue)]">Start with what you already have</p>
        <h1 id="empty-workspace-title" class="mt-3 max-w-[620px] text-[clamp(40px,7vw,72px)] font-semibold leading-[.92] tracking-[-.065em] text-neutral-950">Bring your information. Give it an intention.</h1>
        <p class="mt-5 max-w-[570px] text-[16px] leading-7 text-neutral-500">HII keeps your sources, agent work, and proof together on this canvas.</p>
        <div class="mt-8 grid gap-3 sm:grid-cols-3">
          <button class="rounded-2xl bg-[var(--hii-electric-blue)] p-4 text-left text-white shadow-lg shadow-blue-500/15" on:click={()=>void summonComposer()}>
            <span class="block font-mono text-[9px] uppercase tracking-[0.1em] text-white/70">⌥ Space</span>
            <strong class="mt-3 block text-[15px]">Tell HII the outcome</strong>
          </button>
          <button class="rounded-2xl border border-neutral-900/10 bg-neutral-50 p-4 text-left hover:border-neutral-900/25" on:click={()=>fileInput?.click()}>
            <span class="block font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-400">Files + folders</span>
            <strong class="mt-3 block text-[15px]">Bring in information</strong>
          </button>
          <button class="rounded-2xl border border-neutral-900/10 bg-neutral-50 p-4 text-left hover:border-neutral-900/25" on:click={()=>spawn('explorer')}>
            <span class="block font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-400">Workspace objects</span>
            <strong class="mt-3 block text-[15px]">Explore what HII can do</strong>
          </button>
        </div>
        <p class="mt-6 text-center font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-400">paste or drop anywhere · ⌘K for every command · your files stay local</p>
      </div>
    </section>
  {/if}
  <input bind:this={fileInput} type="file" multiple class="sr-only" aria-label="Upload files to workspace" on:change={(event)=>{void addFiles([...(event.currentTarget.files||[])]);event.currentTarget.value=''}}/>
  <button class="absolute right-5 top-4 rounded-full bg-[var(--hii-electric-blue)] px-4 py-2 font-mono text-[11px] text-white shadow-lg" on:click={refreshDaemon}><i class="mr-2 inline-block h-2 w-2 rounded-full bg-[var(--hii-acid-green)]"></i>hiid {daemon?.instances?.length||context?.capabilities?.length||'…'}</button>
  {#if omnibar}<div class="absolute inset-0 z-50 bg-white/80 backdrop-blur-sm"><button type="button" class="absolute inset-0 cursor-default" aria-label="Close command palette" on:click={()=>omnibar=false}></button><div class="absolute left-1/2 top-1/2 w-[min(620px,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Create workspace object"><div class="flex items-center gap-3 border-b p-4"><span>⌘K</span><input bind:this={commandInput} bind:value={query} class="w-full outline-none" placeholder="Open a tool, create an object, or upload…" /></div><div class="max-h-[420px] overflow-auto p-2">{#each commands as command}<button class="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-neutral-50" on:click={()=>runCommand(command)}><span class="text-xl">{command[0]==='surface'?'↗':'+'}</span><span class="flex-1"><strong class="block">{command[1]}</strong><small class="text-neutral-400">{command[2]}</small></span><kbd class="font-mono text-[10px] text-neutral-400">{command[0]==='surface'?'open':command[0]==='upload'?'choose':'create'}</kbd></button>{/each}</div></div></div>{/if}
</main>{/if}
