<script lang="ts">
  import { onMount } from 'svelte';
  import type { WorkspaceNode } from '@/lib/workspace/types';
  export let node:WorkspaceNode; export let onPayload:(patch:Record<string,unknown>)=>void;
  type Result={title:string;url:string;description:string};
  let input=String(node.payload.url??node.payload.query??''), view:'idle'|'loading'|'page'|'blocked'|'results'|'error'='idle', url='', results:Result[]=[], message='', history:string[]=[], index=-1;
  const normalize=(value:string)=>/^https?:\/\//i.test(value)?value:/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)?`https://${value}`:null;
  async function navigate(value:string,push=true){const next=normalize(value)??value;if(!/^https?:\/\//.test(next))return search(value);input=next;url=next;view='loading';onPayload({url:next,title:new URL(next).hostname});if(push){history=[...history.slice(0,index+1),next];index=history.length-1}try{const response=await fetch(`/api/browse/check?url=${encodeURIComponent(next)}`),data=await response.json();url=data.finalUrl||next;view=data.frameable?'page':'blocked'}catch{view='error';message='embedded browsing failed'}}
  async function search(query:string){view='loading';onPayload({query,title:`search: ${query}`});try{const response=await fetch(`/api/search?q=${encodeURIComponent(query)}`),data=await response.json();if(!response.ok)throw new Error();results=data.results??[];view='results'}catch{navigate(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`)}}
  function submit(){const value=input.trim();if(value)(normalize(value)?navigate(value):search(value))}
  function go(delta:number){const next=index+delta;if(!history[next])return;index=next;navigate(history[next],false)}
  async function external(){await fetch('/api/files/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})})}
  onMount(()=>{if(input)void navigate(input)});
</script>
<div class="flex h-full flex-col bg-white"><div class="flex h-8 items-center gap-1.5 border-b px-2"><button disabled={index<=0} on:click={()=>go(-1)}>←</button><button disabled={index<0||index>=history.length-1} on:click={()=>go(1)}>→</button><button on:click={()=>url&&navigate(url,false)}>↻</button><button on:click={()=>{view='idle';input='';url=''}}>h</button><input class="w-full bg-transparent font-mono text-[11px] outline-none" bind:value={input} on:keydown={(e)=>e.key==='Enter'&&submit()} placeholder="url or search…"/><span class="rounded-full border px-2 font-mono text-[9px] text-neutral-400">{view==='page'?'embedded':view}</span></div><div class="scroll min-h-0 flex-1 overflow-auto">
{#if view==='idle'}<div class="grid h-full place-items-center text-center"><div><strong class="font-mono text-xs">browser, inside HII</strong><p class="mt-1 text-[11px] text-neutral-400">open a web address or search without leaving the workspace</p></div></div>
{:else if view==='loading'}<div class="grid h-full place-items-center font-mono text-[11px] text-neutral-400">checking embed…</div>
{:else if view==='page'}<iframe src={url} title={url} sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" class="h-full w-full border-0"></iframe>
{:else if view==='blocked'}<div class="grid h-full place-items-center p-6 text-center"><div><strong>this site blocks in-app browsing</strong><p class="mt-2 break-all font-mono text-[10px]">{url}</p><button class="hii-command-button mt-4" on:click={external}>open externally</button></div></div>
{:else if view==='results'}<div class="divide-y">{#each results as result}<button class="block w-full p-3 text-left hover:bg-neutral-50" on:click={()=>navigate(result.url)}><strong class="text-[13px] text-[var(--hii-electric-blue)]">{result.title}</strong><small class="block truncate font-mono text-[9px] text-neutral-400">{result.url}</small><p class="mt-1 line-clamp-2 text-[11px]">{result.description}</p></button>{/each}</div>
{:else}<div class="grid h-full place-items-center font-mono text-[11px]">{message}</div>{/if}</div></div>
