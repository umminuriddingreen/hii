<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import EcosystemNav from '$lib/components/EcosystemNav.svelte';

  type Capture={id:string;title:string;url:string;contentHash:string};
  type Workflow={id:string;title:string;projectId:string;revision:number;revisionHash:string;nodes:Array<{id:string;kind:string;title:string;config?:Record<string,unknown>}>;edges:Array<{from:string;to:string}>;adapter:{prompt:Record<string,unknown>}};
  let captures:Capture[]=[];let workflows:Workflow[]=[];let selectedWorkflow='';let selectedCapture='';let title='Untitled creation';let projectId='default';let promptJson='{}';let approved=false;let comfy:any=null;let message='';let saving=false;let promptId='';let runPoll:ReturnType<typeof setTimeout>|null=null;

  const baseNodes=()=>[
    {id:'source',kind:'capture',title:captures.find(item=>item.id===selectedCapture)?.title||'Source context',config:{captureId:selectedCapture}},
    {id:'prompt',kind:'prompt',title:'Creative direction'},
    {id:'comfy',kind:'capability',title:'ComfyUI',capabilityId:'thirdparty.comfyui'},
    {id:'approval',kind:'approval',title:'Human approval'},
    {id:'output',kind:'output',title:'Verified artifact'}
  ];
  const edges=[{from:'source',to:'prompt'},{from:'prompt',to:'comfy'},{from:'comfy',to:'approval'},{from:'approval',to:'output'}];

  async function refresh(){
    const [captureResponse,workflowResponse,comfyResponse]=await Promise.all([fetch('/api/ecosystem?mode=captures'),fetch('/api/ecosystem?mode=workflows'),fetch('/api/ecosystem?mode=comfy')]);
    if(captureResponse.ok)captures=(await captureResponse.json()).captures||[];
    if(workflowResponse.ok)workflows=(await workflowResponse.json()).workflows||[];
    if(comfyResponse.ok)comfy=await comfyResponse.json();
    if(!selectedCapture&&captures[0])selectedCapture=captures[0].id;
  }

  function openWorkflow(id:string){
    const workflow=workflows.find(item=>item.id===id);if(!workflow)return;
    selectedWorkflow=workflow.id;title=workflow.title;projectId=workflow.projectId;promptJson=JSON.stringify(workflow.adapter.prompt,null,2);selectedCapture=String(workflow.nodes.find(node=>node.kind==='capture')?.config?.captureId||selectedCapture);approved=false;message=`Opened revision ${workflow.revision}.`;
  }

  async function save(){
    saving=true;message='';
    try{
      const prompt=JSON.parse(promptJson) as Record<string,unknown>;
      const response=await fetch('/api/ecosystem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'workflow.save',id:selectedWorkflow||undefined,title,projectId,nodes:baseNodes(),edges,adapter:{id:'comfyui',prompt}})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'Workflow save failed.');
      selectedWorkflow=data.workflow.id;message=`Saved revision ${data.workflow.revision} · ${data.workflow.revisionHash.slice(0,10)}`;await refresh();
    }catch(error){message=error instanceof Error?error.message:'Workflow save failed.'}finally{saving=false}
  }

  async function run(){
    if(!selectedWorkflow){message='Save the workflow before running it.';return}
    const response=await fetch('/api/ecosystem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'workflow.run',workflowId:selectedWorkflow,approved})});
    const data=await response.json();
    if(!response.ok){message=data.error||'Workflow could not be queued.';return}
    promptId=data.queued.promptId;message=`Queued in ComfyUI · ${promptId}`;approved=false;runPoll=setTimeout(()=>void refreshRun(),1200);
  }

  async function refreshRun(){
    if(!promptId||!selectedWorkflow)return;
    const response=await fetch('/api/ecosystem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'workflow.refresh',workflowId:selectedWorkflow,promptId})});
    const data=await response.json();
    if(!response.ok){message=data.error||'Could not refresh the ComfyUI run.';return}
    message=data.status==='completed'?`Completed · ${data.outputs.length} verified output reference${data.outputs.length===1?'':'s'}`:`Running in ComfyUI · ${promptId}`;
    if(data.status!=='completed')runPoll=setTimeout(()=>void refreshRun(),1800);
  }

  onMount(()=>{const requested=new URLSearchParams(location.search).get('capture');if(requested)selectedCapture=requested;void refresh()});
  onDestroy(()=>{if(runPoll)clearTimeout(runPoll)});
</script>

<svelte:head><title>Create — HII</title></svelte:head>

<main class="create-mode">
  <header class="mode-header"><div><p>HII / visual workflows</p><h1>Create</h1></div><EcosystemNav current="create" /></header>
  <section class="studio">
    <aside class="library">
      <div class="status"><i class:ready={comfy?.available}></i><span>{comfy?.message||'Checking local ComfyUI…'}</span></div>
      <p class="eyebrow">Workflows</p>
      <button class="new" on:click={()=>{selectedWorkflow='';title='Untitled creation';promptJson='{}';approved=false;message=''}}>+ New workflow</button>
      {#each workflows as workflow}<button class:active={workflow.id===selectedWorkflow} class="workflow-row" on:click={()=>openWorkflow(workflow.id)}><strong>{workflow.title}</strong><span>revision {workflow.revision} · {workflow.revisionHash.slice(0,8)}</span></button>{:else}<p class="empty">No workflows yet.</p>{/each}
    </aside>
    <div class="editor">
      <div class="meta"><label>Title<input bind:value={title} /></label><label>Project<input bind:value={projectId} /></label><label>Source<select bind:value={selectedCapture}><option value="">No captured source</option>{#each captures as capture}<option value={capture.id}>{capture.title}</option>{/each}</select></label></div>
      <div class="graph" aria-label="Workflow graph">
        {#each baseNodes() as node,index}<article class:approval={node.kind==='approval'} class:output={node.kind==='output'}><span>{node.kind}</span><strong>{node.title}</strong>{#if node.capabilityId}<small>{node.capabilityId}</small>{/if}</article>{#if index<baseNodes().length-1}<b>→</b>{/if}{/each}
      </div>
      <label class="prompt">ComfyUI API prompt<textarea bind:value={promptJson} spellcheck="false"></textarea><small>Paste the API-format prompt exported by ComfyUI. It is versioned with this HII workflow.</small></label>
      <footer><div>{#if message}<p>{message}</p>{/if}</div><button class="save" disabled={saving} on:click={()=>void save()}>{saving?'Saving…':'Save revision'}</button><label class="approve"><input type="checkbox" bind:checked={approved} /> I reviewed this exact revision</label><button class="run" disabled={!approved||!selectedWorkflow||!comfy?.available} on:click={()=>void run()}>Queue in ComfyUI</button></footer>
    </div>
  </section>
</main>

<style>
  .create-mode{min-height:100%;box-sizing:border-box;background:#efeee9;padding:28px;color:#15171a}.mode-header{display:flex;align-items:end;justify-content:space-between;gap:24px;max-width:1500px;margin:0 auto 20px}.mode-header p,.eyebrow{margin:0;color:#176bff;font:700 9px ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase}.mode-header h1{margin:6px 0 0;font-size:44px;letter-spacing:-.055em}.studio{display:grid;grid-template-columns:270px minmax(0,1fr);max-width:1500px;min-height:620px;margin:auto;overflow:hidden;border:1px solid #d8d7d1;border-radius:24px;background:white;box-shadow:0 24px 80px rgba(30,34,42,.1)}.library{padding:22px;border-right:1px solid #e5e4df;background:#f8f7f3}.status{display:flex;gap:8px;align-items:center;margin-bottom:32px;color:#74777b;font-size:11px}.status i{width:8px;height:8px;border-radius:50%;background:#d3443c}.status i.ready{background:#39cb74}.new,.workflow-row{width:100%;border:0;border-radius:12px;text-align:left}.new{margin:12px 0 8px;padding:11px;background:#111317;color:#fff;font-size:11px}.workflow-row{display:grid;gap:4px;padding:12px;background:transparent}.workflow-row:hover,.workflow-row.active{background:#e9efff}.workflow-row strong{font-size:12px}.workflow-row span{color:#92959a;font:8px ui-monospace,monospace}.empty{color:#999;font-size:11px}.editor{display:flex;min-width:0;flex-direction:column;padding:28px}.meta{display:grid;grid-template-columns:2fr 1fr 2fr;gap:12px}.meta label,.prompt{display:grid;gap:7px;color:#777;font:700 9px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.meta input,.meta select{height:40px;border:1px solid #ddd;border-radius:10px;padding:0 11px;background:white}.graph{display:flex;align-items:center;justify-content:flex-start;gap:6px;min-height:210px;margin:20px 0;border:1px solid #e2e1dc;border-radius:18px;background:#f8f7f3;padding:18px;overflow:auto}.graph article{box-sizing:border-box;display:grid;flex:0 0 118px;gap:8px;padding:13px;border:1px solid #d5d4cf;border-radius:14px;background:white;box-shadow:0 8px 24px rgba(20,24,30,.06)}.graph article.approval{border-color:#176bff}.graph article.output{background:#111317;color:white}.graph span{color:#8b8e92;font:8px ui-monospace,monospace;text-transform:uppercase}.graph strong{font-size:12px}.graph small{overflow:hidden;color:#176bff;font:7px ui-monospace,monospace;text-overflow:ellipsis}.graph b{color:#a8aaad}.prompt{flex:1}.prompt textarea{min-height:190px;resize:vertical;border:1px solid #d9d8d3;border-radius:14px;background:#15171a;color:#e9edf3;padding:16px;font:11px/1.55 ui-monospace,monospace;text-transform:none}.prompt small{color:#989a9d;font-weight:400;letter-spacing:0;text-transform:none}footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:18px}footer>div{flex:1}footer p{margin:0;color:#176bff;font-size:11px}.save,.run{height:40px;border:0;border-radius:999px;padding:0 16px}.save{background:#e8e8e5}.run{background:#176bff;color:white}.run:disabled{opacity:.35}.approve{display:flex;align-items:center;gap:6px;color:#666;font-size:10px}@media(max-width:1000px){.studio{grid-template-columns:1fr}.library{border-right:0;border-bottom:1px solid #ddd}.meta{grid-template-columns:1fr}.mode-header{align-items:start;flex-direction:column}.graph{justify-content:start}}
</style>
