<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';
  export let node:WorkspaceNode;
  export let onPayload:(patch:Record<string,unknown>)=>void;
  export let onSize:(size:{w:number;h:number})=>void=()=>{};
  const text=(key:string)=>String(node.payload[key]??'');
  const size=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)?n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`:''};
  const fitImage=(event:Event)=>{const image=event.currentTarget as HTMLImageElement;if(!image.naturalWidth||!image.naturalHeight)return;const ratio=image.naturalWidth/image.naturalHeight,current=node.w/node.h;const next=current>ratio?{w:node.h*ratio,h:node.h}:{w:node.w,h:node.w/ratio};if(Math.abs(next.w-node.w)>1||Math.abs(next.h-node.h)>1)onSize(next)};
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
            <img src={String(item.url||'')} alt={String(item.name||'Reference image')} loading="lazy" class="aspect-square w-full object-cover"/>
            <span class="block truncate px-2 py-1.5 font-mono text-[8px] text-neutral-500 group-hover/item:text-blue-700">{String(item.name||'image')}</span>
          </a>
        {/each}
      </div>
    </div>
  </section>
{:else if node.type==='image'}
  <figure class="h-full w-full overflow-hidden"><img src={text('url')} alt={text('name')||'Workspace image'} class="h-full w-full object-cover" on:load={fitImage}/></figure>
{:else if node.type==='media'}
  {#if text('kind')==='audio'}<div class="grid h-full place-items-center bg-neutral-950 p-4 text-white"><div class="w-full"><p class="mb-3 truncate font-mono text-[10px]">{text('name')}</p><audio controls src={text('url')} class="w-full"><track kind="captions"/></audio></div></div>
  {:else if text('kind')==='pdf'}<iframe src={text('url')} title={text('name')||'PDF'} class="h-full w-full border-0"></iframe>
  {:else}<video controls src={text('url')} class="h-full w-full bg-black object-contain"><track kind="captions"/></video>{/if}
{:else if node.type==='html'}
  <iframe srcdoc={text('srcdoc')} title={text('name')||'HTML snippet'} sandbox="allow-scripts allow-forms" class="h-full w-full border-0 bg-white"></iframe>
{:else if node.type==='font'}
  <div class="h-full overflow-hidden p-4" style={`font-family:${text('fam')||'sans-serif'}`}><small class="font-mono text-[9px] text-neutral-400">{text('name')}</small><p class="mt-3 text-4xl">Human information</p><p class="mt-2 text-lg">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br/>abcdefghijklmnopqrstuvwxyz 0123456789</p></div>
{/if}
