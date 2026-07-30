<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';
  import {
    normalizeWorkspaceContextAnchor,
    workspaceContextAnchorLabel,
    type WorkspaceContextAnchor
  } from '@/lib/workspace/context-anchor';

  export let node:WorkspaceNode;
  export let onPayload:(patch:Record<string,unknown>)=>void;
  export let onSize:(size:{w:number;h:number})=>void=()=>{};
  const text=(key:string)=>String(node.payload[key]??'');
  const size=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)?n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`:''};
  const fitImage=(event:Event)=>{const image=event.currentTarget as HTMLImageElement;if(!image.naturalWidth||!image.naturalHeight)return;const ratio=image.naturalWidth/image.naturalHeight,current=node.w/node.h;const next=current>ratio?{w:node.h*ratio,h:node.h}:{w:node.w,h:node.w/ratio};if(Math.abs(next.w-node.w)>1||Math.abs(next.h-node.h)>1)onSize(next)};
  let imageHost: HTMLElement;
  let regionMode = false;
  let regionStart: { x: number; y: number } | null = null;
  let draftRegion: Extract<WorkspaceContextAnchor, {kind:'image-region'}> | null = null;
  let mediaElement: HTMLMediaElement;
  const initialAnchor=normalizeWorkspaceContextAnchor(node.payload.contextAnchor);
  let markIn=initialAnchor?.kind==='media-range'?initialAnchor.startSeconds:0;
  let markOut=initialAnchor?.kind==='media-range'?initialAnchor.endSeconds:0;
  let designFrame=initialAnchor?.kind==='design-selection'?initialAnchor.frame||'':'';
  let designLayers=initialAnchor?.kind==='design-selection'?initialAnchor.layers.join(', '):'';
  $: anchor=normalizeWorkspaceContextAnchor(node.payload.contextAnchor);
  $: imageRegion=anchor?.kind==='image-region'?anchor:draftRegion;

  function normalizedPoint(event:PointerEvent) {
    const bounds=imageHost.getBoundingClientRect();
    return {
      x:Math.min(1,Math.max(0,(event.clientX-bounds.left)/Math.max(1,bounds.width))),
      y:Math.min(1,Math.max(0,(event.clientY-bounds.top)/Math.max(1,bounds.height)))
    };
  }

  function beginRegion(event:PointerEvent) {
    if(!regionMode)return;
    event.preventDefault();
    imageHost.setPointerCapture(event.pointerId);
    regionStart=normalizedPoint(event);
    draftRegion={kind:'image-region',x:regionStart.x,y:regionStart.y,width:.001,height:.001,label:'selected image region'};
  }

  function moveRegion(event:PointerEvent) {
    if(!regionStart)return;
    const point=normalizedPoint(event);
    draftRegion={
      kind:'image-region',
      x:Math.min(regionStart.x,point.x),
      y:Math.min(regionStart.y,point.y),
      width:Math.max(.001,Math.abs(point.x-regionStart.x)),
      height:Math.max(.001,Math.abs(point.y-regionStart.y)),
      label:'selected image region'
    };
  }

  function endRegion(event:PointerEvent) {
    if(!regionStart||!draftRegion)return;
    imageHost.releasePointerCapture(event.pointerId);
    regionStart=null;
    if(draftRegion.width>=.01&&draftRegion.height>=.01) {
      onPayload({contextAnchor:draftRegion});
      regionMode=false;
    }
    draftRegion=null;
  }

  function markMedia(boundary:'in'|'out') {
    const current=Math.max(0,Number(mediaElement?.currentTime)||0);
    if(boundary==='in')markIn=current;
    else markOut=current;
    if(markOut>markIn)onPayload({contextAnchor:{kind:'media-range',startSeconds:markIn,endSeconds:markOut}});
  }

  function useDesignSelection() {
    const layers=designLayers.split(',').map((value)=>value.trim()).filter(Boolean);
    if(!designFrame.trim()&&!layers.length)return;
    onPayload({contextAnchor:{kind:'design-selection',frame:designFrame.trim(),layers}});
  }
</script>

{#if node.type==='note'}
  <textarea class="h-full w-full resize-none bg-[#fffef8] p-3 font-mono text-[12px] outline-none" value={text('content')||text('text')} on:input={(e)=>onPayload({content:e.currentTarget.value,text:e.currentTarget.value})} placeholder="note…"></textarea>
{:else if node.type==='text'}
  <div class="flex h-full flex-col bg-white"><div class="border-b px-3 py-1.5 font-mono text-[9px] text-neutral-400">{text('name')||'text'} {node.payload.truncated?'· preview truncated':''}</div><textarea class="min-h-0 flex-1 resize-none p-3 font-mono text-[11px] leading-relaxed outline-none" value={text('content')} on:input={(e)=>onPayload({content:e.currentTarget.value})}></textarea></div>
{:else if node.type==='canvas-text'}
  <textarea class="h-full w-full resize-none overflow-hidden bg-transparent p-2 text-[22px] font-medium leading-tight outline-none" style={`color:${text('color')||'#171717'}`} value={text('text')} on:input={(e)=>onPayload({text:e.currentTarget.value})} placeholder="Type…"></textarea>
{:else if node.type==='ink'}
  <svg class="h-full w-full overflow-visible" viewBox={`0 0 ${node.w} ${node.h}`} aria-label="Canvas ink stroke"><polyline points={(node.payload.points as Array<{x:number;y:number}>||[]).map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={text('color')||'#171717'} stroke-width={Number(node.payload.width)||4} stroke-linecap="round" stroke-linejoin="round" opacity={Number(node.payload.opacity)||1}></polyline></svg>
{:else if node.type==='link'}
  <a href={text('url')} target="_blank" rel="noreferrer" class="flex h-full items-center gap-3 p-3 hover:bg-neutral-50"><span class="grid h-9 w-9 place-items-center rounded-full bg-[var(--hii-soft-blue)] text-[var(--hii-electric-blue)]">↗</span><span class="min-w-0"><strong class="block truncate text-[13px]">{text('name')||text('host')||'link'}</strong><small class="block truncate font-mono text-[9px] text-neutral-400">{text('url')}</small></span></a>
{:else if node.type==='file'&&text('category')==='design'}
  <section aria-label="Design source focus" class="flex h-full flex-col bg-[#f7f5f1] p-4" on:pointerdown|stopPropagation>
    <div class="flex items-start gap-3"><span class="text-2xl">🎨</span><div class="min-w-0"><strong class="block truncate text-[12px]">{text('name')}</strong><small class="font-mono text-[9px] uppercase text-neutral-400">design source · {size(node.payload.size)}</small></div></div>
    <p class="mt-3 text-[10px] leading-4 text-neutral-500">Name the frame and layers that AII may treat as the human-reviewed focus.</p>
    <label class="mt-3 font-mono text-[8px] uppercase tracking-[.08em] text-neutral-400">frame<input aria-label="Design focus frame" class="mt-1 w-full rounded-lg border border-neutral-900/10 bg-white px-2.5 py-2 text-[10px] normal-case text-neutral-800 outline-none focus:border-blue-400" bind:value={designFrame} placeholder="Landing / Hero"/></label>
    <label class="mt-2 font-mono text-[8px] uppercase tracking-[.08em] text-neutral-400">layers<input aria-label="Design focus layers" class="mt-1 w-full rounded-lg border border-neutral-900/10 bg-white px-2.5 py-2 text-[10px] normal-case text-neutral-800 outline-none focus:border-blue-400" bind:value={designLayers} placeholder="Headline, CTA, Product frame"/></label>
    <div class="mt-auto flex items-center gap-2 pt-3">
      <button class="rounded-full bg-[var(--hii-electric-blue)] px-3 py-1.5 font-mono text-[8px] text-white" on:click={useDesignSelection}>use selection</button>
      {#if anchor?.kind==='design-selection'}<button class="rounded-full px-2 py-1.5 font-mono text-[8px] text-neutral-400 hover:bg-white" on:click={()=>onPayload({contextAnchor:null})}>clear</button><span class="min-w-0 truncate rounded-full bg-blue-50 px-2 py-1 font-mono text-[8px] text-blue-700">human focus · {workspaceContextAnchorLabel(anchor)}</span>{/if}
    </div>
  </section>
{:else if node.type==='file'}
  <div class="flex h-full items-center gap-3 p-3"><span class="text-2xl">{text('emoji')||'📄'}</span><div class="min-w-0"><strong class="block truncate text-[12px]">{text('name')}</strong><small class="block font-mono text-[9px] uppercase text-neutral-400">{text('label')||text('category')||'file'} · {size(node.payload.size)}</small><p class="mt-1 text-[10px] text-neutral-500">{text('description')}</p></div></div>
{:else if node.type==='image'&&text('adapter')==='contact-sheet'}
  <section class="flex h-full min-h-0 flex-col overflow-hidden bg-white">
    <header class="flex items-center justify-between gap-3 border-b px-4 py-3">
      <div class="min-w-0"><strong class="block truncate text-[13px]">{text('title')||'Reference contact sheet'}</strong><small class="font-mono text-[8px] uppercase tracking-[.08em] text-neutral-400">{Number(node.payload.uniqueCount)||0} unique references</small></div>
      {#if Number(node.payload.duplicateCount)>0}<span class="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 font-mono text-[8px] uppercase text-amber-700">{Number(node.payload.duplicateCount)} exact duplicate{Number(node.payload.duplicateCount)===1?'':'s'} omitted</span>{/if}
    </header>
    <div class="scroll min-h-0 flex-1 overflow-auto p-3">
      <div class="grid gap-2" style={`grid-template-columns:repeat(${Number(node.payload.columns)||4},minmax(0,1fr))`}>
        {#each (node.payload.items as Array<Record<string,unknown>>||[]) as item}
          <a href={String(item.url||'')} target="_blank" rel="noreferrer" class="group/item overflow-hidden rounded-xl border border-neutral-900/10 bg-neutral-50 hover:border-blue-400" title={String(item.path||item.name||'Reference image')}>
            <img src={String(item.url||'')} alt={String(item.name||'Reference image')} loading="lazy" class="aspect-video w-full bg-neutral-100 object-contain"/>
            <span class="block truncate px-2 py-1.5 font-mono text-[8px] text-neutral-500 group-hover/item:text-blue-700">{String(item.name||'image')}</span>
          </a>
        {/each}
      </div>
    </div>
  </section>
{:else if node.type==='image'}
  <figure bind:this={imageHost} class="relative h-full w-full overflow-hidden bg-neutral-100" class:cursor-crosshair={regionMode} on:pointerdown={beginRegion} on:pointermove={moveRegion} on:pointerup={endRegion}>
    <img src={text('url')} alt={text('name')||'Workspace image'} class="h-full w-full object-contain" draggable="false" on:load={fitImage}/>
    {#if imageRegion}<span class="pointer-events-none absolute border-2 border-blue-500 bg-blue-400/15 shadow-[0_0_0_9999px_rgba(0,0,0,.18)]" style={`left:${imageRegion.x*100}%;top:${imageRegion.y*100}%;width:${imageRegion.width*100}%;height:${imageRegion.height*100}%`}></span>{/if}
    <div role="group" aria-label="Image focus controls" class="absolute left-3 top-3 flex items-center gap-1 rounded-full border border-black/10 bg-white/90 p-1 shadow-sm backdrop-blur" on:pointerdown|stopPropagation>
      <button class="rounded-full px-2.5 py-1 font-mono text-[8px] hover:bg-neutral-100" class:bg-blue-500={regionMode} class:text-white={regionMode} on:click={()=>regionMode=!regionMode}>{regionMode?'drag region':'focus region'}</button>
      {#if anchor?.kind==='image-region'}<button class="rounded-full px-2 py-1 font-mono text-[8px] text-neutral-400 hover:bg-neutral-100" on:click={()=>onPayload({contextAnchor:null})}>clear</button><span class="max-w-40 truncate rounded-full bg-blue-50 px-2 py-1 font-mono text-[8px] text-blue-700">human focus · {workspaceContextAnchorLabel(anchor)}</span>{/if}
    </div>
  </figure>
{:else if node.type==='media'}
  {#if text('kind')==='audio'}<div class="relative grid h-full place-items-center bg-neutral-950 p-4 text-white"><div class="w-full"><p class="mb-3 truncate font-mono text-[10px]">{text('name')}</p><audio bind:this={mediaElement} controls src={text('url')} class="w-full"><track kind="captions"/></audio></div>
    <div role="group" aria-label="Audio focus controls" class="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-white/10 bg-black/70 p-1" on:pointerdown|stopPropagation><button class="rounded-full px-2 py-1 font-mono text-[8px] hover:bg-white/10" on:click={()=>markMedia('in')}>in {markIn.toFixed(1)}s</button><button class="rounded-full px-2 py-1 font-mono text-[8px] hover:bg-white/10" on:click={()=>markMedia('out')}>out {markOut.toFixed(1)}s</button>{#if anchor?.kind==='media-range'}<span class="rounded-full bg-blue-500/25 px-2 py-1 font-mono text-[8px] text-blue-200">human focus · {workspaceContextAnchorLabel(anchor)}</span><button class="rounded-full px-2 py-1 font-mono text-[8px] text-white/45 hover:bg-white/10" on:click={()=>onPayload({contextAnchor:null})}>clear</button>{/if}</div>
  </div>
  {:else if text('kind')==='pdf'}<iframe src={text('url')} title={text('name')||'PDF'} class="h-full w-full border-0"></iframe>
  {:else}<div class="relative h-full w-full bg-black"><video bind:this={mediaElement} controls src={text('url')} class="h-full w-full object-contain"><track kind="captions"/></video><div role="group" aria-label="Video focus controls" class="absolute right-3 top-3 flex items-center gap-1 rounded-full border border-white/10 bg-black/70 p-1 text-white" on:pointerdown|stopPropagation><button class="rounded-full px-2 py-1 font-mono text-[8px] hover:bg-white/10" on:click={()=>markMedia('in')}>in {markIn.toFixed(1)}s</button><button class="rounded-full px-2 py-1 font-mono text-[8px] hover:bg-white/10" on:click={()=>markMedia('out')}>out {markOut.toFixed(1)}s</button>{#if anchor?.kind==='media-range'}<span class="rounded-full bg-blue-500/25 px-2 py-1 font-mono text-[8px] text-blue-200">human focus · {workspaceContextAnchorLabel(anchor)}</span><button class="rounded-full px-2 py-1 font-mono text-[8px] text-white/45 hover:bg-white/10" on:click={()=>onPayload({contextAnchor:null})}>clear</button>{/if}</div></div>{/if}
{:else if node.type==='html'}
  <iframe srcdoc={text('srcdoc')} title={text('name')||'HTML snippet'} sandbox="allow-scripts allow-forms" class="h-full w-full border-0 bg-white"></iframe>
{:else if node.type==='font'}
  <div class="h-full overflow-hidden p-4" style={`font-family:${text('fam')||'sans-serif'}`}><small class="font-mono text-[9px] text-neutral-400">{text('name')}</small><p class="mt-3 text-4xl">Human information</p><p class="mt-2 text-lg">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br/>abcdefghijklmnopqrstuvwxyz 0123456789</p></div>
{/if}
