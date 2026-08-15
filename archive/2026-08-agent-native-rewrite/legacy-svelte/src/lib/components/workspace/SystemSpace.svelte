<script lang="ts">
  import { onMount } from 'svelte';

  type SystemWindow = { id:number; app:string; title:string; spaceId:string };
  type SystemSpace = { id:string; focused:boolean; visible:boolean; empty:boolean; windowIds:number[] };
  type SystemLayer = { backend:string; mutationAvailable:boolean; focusedSpaceId:string|null; spaces:SystemSpace[]; windows:SystemWindow[] };

  let system:SystemLayer|null=null;
  let state:'loading'|'ready'|'attention'='loading';
  let detail='Reading the local desktop…';
  let switching='';

  const windowFor=(id:number)=>system?.windows.find((window)=>window.id===id);
  $: focusedSpace=system?.spaces.find((space)=>space.id===system?.focusedSpaceId);

  async function refresh(){
    try{
      const response=await fetch('/api/space');
      const result=await response.json();
      if(!response.ok||!result.ok||!result.system)throw new Error(result.error||result.health?.summary||'System space is unavailable.');
      system=result.system;state='ready';detail='';
    }catch(error){state='attention';detail=error instanceof Error?error.message:'System space is unavailable.'}
  }

  async function switchSpace(spaceId:string){
    if(!system?.mutationAvailable||switching)return;
    switching=spaceId;
    try{
      const response=await fetch('/api/space',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'switch-space',spaceId})});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error||'HII could not switch system spaces.');
      await refresh();
    }catch(error){state='attention';detail=error instanceof Error?error.message:'HII could not switch system spaces.'}
    finally{switching=''}
  }

  onMount(()=>{void refresh()});
  onMount(()=>{const refreshFromSystem=()=>void refresh();window.addEventListener('hii:space-refresh',refreshFromSystem);return()=>window.removeEventListener('hii:space-refresh',refreshFromSystem)});
</script>

<section class="mt-8 border-t border-neutral-900/10 pt-5" aria-label="HII system space">
  <div class="flex items-center justify-between gap-4">
    <div>
      <p class="font-mono text-[9px] font-bold uppercase tracking-[.13em] text-neutral-400">System space</p>
      <p class="mt-1 text-[13px] text-neutral-600">HII sees the desktop as one command surface.</p>
    </div>
    {#if system}<span class="rounded-full bg-neutral-100 px-3 py-1.5 font-mono text-[8px] uppercase tracking-[.1em] text-neutral-500">{system.backend} · {system.windows.length} windows</span>{/if}
  </div>
  {#if state==='loading'}
    <p class="mt-4 font-mono text-[10px] text-neutral-400">{detail}</p>
  {:else if !system}
    <p class="mt-4 rounded-xl bg-amber-50 p-3 font-mono text-[10px] text-amber-800">{detail}</p>
  {:else}
    <div class="mt-4 flex flex-wrap gap-2">
      {#each system.spaces as space}
        <button
          class={`min-w-11 rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-default ${space.focused?'border-blue-500 bg-blue-50':'border-neutral-900/10 bg-neutral-50'}`}
          disabled={!system.mutationAvailable||Boolean(switching)||space.focused}
          title={space.empty?`Space ${space.id} is empty`:`Space ${space.id} has ${space.windowIds.length} windows`}
          on:click={()=>void switchSpace(space.id)}
        >
          <span class="block font-mono text-[10px] font-bold" class:text-blue-700={space.focused}>{switching===space.id?'…':space.id}</span>
          <span class="mt-1 block h-1.5 w-1.5 rounded-full" class:bg-neutral-300={space.empty} class:bg-emerald-500={!space.empty}></span>
        </button>
      {/each}
    </div>
    {#if system.focusedSpaceId}
      <div class="mt-4 flex flex-wrap gap-2 text-[11px] text-neutral-500">
        {#if focusedSpace?.empty}<span>No app windows in system space {focusedSpace.id}. HII remains available above it.</span>
        {:else}{#each focusedSpace?.windowIds||[] as id}{@const window=windowFor(id)}{#if window}<span class="rounded-full border border-neutral-900/10 bg-white px-2.5 py-1">{window.app} · {window.title||'Untitled'}</span>{/if}{/each}{/if}
      </div>
    {/if}
    {#if detail}<p class="mt-3 font-mono text-[9px] text-amber-700">{detail}</p>{/if}
  {/if}
</section>
