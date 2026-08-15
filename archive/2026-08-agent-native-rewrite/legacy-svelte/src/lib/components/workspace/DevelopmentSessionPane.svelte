<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import SpatialRunPane from '$lib/components/workspace/SpatialRunPane.svelte';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node:WorkspaceNode;
  export let onPatch:(patch:Partial<WorkspaceNode>)=>void;
  export let onFollowUp:(text:string)=>void;
  export let onComplete:(result:Record<string,unknown>)=>void;
  export let onCapabilityDraft:(result:Record<string,unknown>)=>void;

  type DevelopmentSnapshot={state:string;web:{ready:boolean;previewUrl:string;mode:string;pid:number|null};native:{mode:string;previewApp:string;boundary:string};workspaceRoot:string};
  let development:DevelopmentSnapshot|null=(node.payload.development as DevelopmentSnapshot)||null;
  let error='';
  let timer:ReturnType<typeof setInterval>|null=null;
  let frameKey=0;

  async function update(start=false){
    try{
      const response=await fetch('/api/development/session',start?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start'})}:undefined);
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'HII development preview is unavailable.');
      const changed=JSON.stringify(result)!==JSON.stringify(development);
      development=result;error='';
      if(changed)onPatch({payload:{...node.payload,development:result}});
    }catch(caught){error=caught instanceof Error?caught.message:'HII development preview is unavailable.'}
  }

  onMount(()=>{void update(true);timer=setInterval(()=>void update(),4000)});
  onDestroy(()=>{if(timer)clearInterval(timer)});
</script>

<div class="grid h-full min-h-0 grid-cols-[minmax(300px,42%)_1fr] bg-neutral-950 text-white">
  <section class="min-h-0 border-r border-white/10 bg-white text-neutral-950">
    <SpatialRunPane {node} {onPatch} {onFollowUp} {onComplete} {onCapabilityDraft} />
  </section>
  <section class="flex min-h-0 flex-col">
    <header class="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
      <div><p class="font-mono text-[9px] uppercase tracking-[.12em] text-white/45">Live HII projection</p><p class="mt-1 text-xs text-white/75">{development?.web.mode||'Svelte HMR'} · {development?.web.ready?'ready':'starting'}</p></div>
      <button class="rounded-full border border-white/15 px-3 py-1.5 font-mono text-[8px] uppercase tracking-[.08em] text-white/70" on:click={()=>frameKey+=1}>reload preview</button>
    </header>
    {#if development?.web.ready}
      {#key frameKey}<iframe class="min-h-0 flex-1 border-0 bg-white" title="HII hot development preview" src={development.web.previewUrl}></iframe>{/key}
    {:else}<div class="grid min-h-0 flex-1 place-items-center p-6 text-center font-mono text-[10px] text-white/45">{error||'Starting the local HII web preview…'}</div>{/if}
    <footer class="border-t border-white/10 px-4 py-3 font-mono text-[9px] leading-4 text-white/45">
      Web UI changes hot-load here. Native Rust/Tauri changes require a separate <span class="text-white/75">HII Preview.app</span> rebuild and relaunch; the running /Applications/HII.app is never replaced by this session.
    </footer>
  </section>
</div>
