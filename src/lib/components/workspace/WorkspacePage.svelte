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
  import RunArtifactPane from '$lib/components/workspace/RunArtifactPane.svelte';
  import GovernedResultPane from '$lib/components/workspace/GovernedResultPane.svelte';
  import GovernedCapabilityPane from '$lib/components/workspace/GovernedCapabilityPane.svelte';
  import SurfacePane from '$lib/components/workspace/SurfacePane.svelte';
  import StaticNode from '$lib/components/workspace/StaticNode.svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';
  import type { WorkspaceDoc, WorkspaceNode, WorkspaceNodeType } from '@/lib/workspace/types';
  import { makeNode, seedFor, seedFromString, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
  import { countWorkspaceNodesInViewport, fitWorkspaceViewport, panWorkspaceViewport, zoomWorkspaceViewportAt } from '@/lib/workspace/viewport';
  import { searchWorkspaceNodes, workspaceNodeTitle } from '@/lib/workspace/search';
  import { assignNodesToFrame, moveNodeAndFrameContents, removeFrame } from '@/lib/workspace/frames';
  import { adjacentWorkspaceScene, workspaceSceneMembers, workspaceScenes, workspaceSceneTypeSummary } from '@/lib/workspace/scenes';
  import { emptyWorkspaceHistory, recordWorkspaceChange, redoWorkspace, undoWorkspace } from '@/lib/workspace/history';
  import { workspaceConnections } from '@/lib/workspace/connections';
  import { findOpenWorkspacePosition } from '@/lib/workspace/layout';

  export let data: { enabled: boolean };
  const surfaceCatalog = [
    { id:'knowledge', title:'Knowledge', path:'/knowledge', capabilityId:'hii.knowledge.workspace', detail:'canonical notes · systems · proof' },
    { id:'activate', title:'Activation', path:'/activate', capabilityId:'hii.agent.workspace_run', detail:'choose agent · approve context · run' },
    { id:'boards', title:'Boards', path:'/boards', capabilityId:'hii.board.task_kanban', detail:'bounded work · owners · blockers' },
    { id:'console', title:'Console', path:'/console', capabilityId:'hii.terminal.observe', detail:'agents · logs · receipts' }
  ];
  let doc:WorkspaceDoc={version:1,revision:0,updatedAt:new Date().toISOString(),viewport:{x:0,y:0,zoom:1},nextZ:1,nodes:[]};
  let ready=false; let loadState:'loading'|'ready'|'recovery'='loading'; let loadError=''; let recoveryPath=''; let saveError='';
  let workspaceId='default'; let workspaces:Array<{id:string;selected:boolean;status:'ready'|'recovery';revision?:number}>=[]; let workspaceMenu=false;
  let selected:string|null=null; let contextSelection:string[]=[]; let omnibar=false; let query=''; let mapMenu=false; let currentSceneId:string|null=null; let canvasWidth=0; let canvasHeight=0; let saveTimer:ReturnType<typeof setTimeout>|undefined; let saveInFlight=false; let savePending=false;
  let context:any=null; let board:any[]=[]; let daemon:any=null; let healthOpen=false; let daemonActionBusy=false; let canvas:HTMLElement; let mouse={x:400,y:300};
  let commandInput:HTMLInputElement; let fileInput:HTMLInputElement;
  let composerOpen=false; let composerText=''; let composerInput:HTMLTextAreaElement; let composerAt={x:400,y:280}; let lastSummon=0;
  let ModelPaneComponent:any=null; let modelPanePromise:Promise<void>|null=null; let modelPaneError='';
  let workspaceHistory=emptyWorkspaceHistory();
  $: commands=[
    ['fit','Fit all content','take me to my stuff · ⇧1'],
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
    ['frame','New scene','name, capture, focus, and move related objects together'],
    ['sound-field','Open South Berkeley sound field','modeled dBA']
  ].filter(item=>`${item[1]} ${item[2]}`.toLowerCase().includes(query.toLowerCase()));
  $: nodeResults=searchWorkspaceNodes(doc.nodes,query);
  $: collapsedFrameIds=new Set(doc.nodes.filter(node=>node.type==='frame'&&node.payload.collapsed===true).map(node=>node.id));
  $: scenes=workspaceScenes(doc.nodes);
  $: mapAnchors=doc.nodes.filter(node=>!['frame','image','media','ink','canvas-text','text'].includes(node.type)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,8);
  $: mapKinds=Object.entries(doc.nodes.reduce<Record<string,number>>((counts,node)=>({...counts,[node.type]:(counts[node.type]||0)+1}),{})).sort((a,b)=>b[1]-a[1]).slice(0,5);
  $: selectedContextNodes=contextSelection.map(id=>doc.nodes.find(node=>node.id===id)).filter((node):node is WorkspaceNode=>Boolean(node));
  $: connections=workspaceConnections(doc.nodes);
  $: visibleNodeCount=countWorkspaceNodesInViewport(doc.nodes,doc.viewport,{width:canvasWidth,height:canvasHeight});
  $: contentOutsideView=loadState==='ready'&&doc.nodes.length>0&&canvasWidth>0&&canvasHeight>0&&visibleNodeCount===0;
  $: runtimeHealth=daemon?.health||{state:'attention',label:'AII checking',summary:'Reading the local runtime heartbeat.',recoveryAction:null,recoveryLabel:null,heartbeatAgeSeconds:null,activeRuns:0,queuedRuns:0,ownedServices:0,observedProcesses:0};

  function ensureModelPane(){if(ModelPaneComponent||modelPanePromise)return;modelPanePromise=import('$lib/components/workspace/ModelPane.svelte').then(module=>{ModelPaneComponent=module.default;modelPaneError=''}).catch(error=>{modelPanePromise=null;modelPaneError=error instanceof Error?error.message:'3D viewer unavailable'})}
  async function refreshWorkspaces(){try{const response=await fetch('/api/workspace?list=1');const result=await response.json();if(response.ok)workspaces=result.workspaces||[]}catch{}}
  async function load(requestedWorkspaceId?:string){
    loadState='loading';loadError='';recoveryPath='';saveError='';
    try{
      const response=await fetch(requestedWorkspaceId?`/api/workspace?workspaceId=${encodeURIComponent(requestedWorkspaceId)}`:'/api/workspace');
      const result=await response.json().catch(()=>({}));
      if(!response.ok||result.status==='recovery'){
        loadState='recovery';loadError=result.error||'HII could not load this workspace.';recoveryPath=result.recoveryPath||'';return;
      }
      workspaceId=result.workspaceId||requestedWorkspaceId||'default';doc=result.workspace;workspaceHistory=emptyWorkspaceHistory();selected=null;contextSelection=[];currentSceneId=null;loadState='ready';
      void refreshWorkspaces();
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
      const response=await fetch('/api/workspace',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,workspace:doc,expectedRevision})});
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
  function remember(before:WorkspaceDoc){workspaceHistory=recordWorkspaceChange(workspaceHistory,before)}
  async function switchWorkspace(id:string){
    if(id===workspaceId){workspaceMenu=false;return}
    if(saveInFlight){saveError='Wait for the current workspace save to finish before switching.';return}
    const needsSave=Boolean(saveTimer);
    if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined}
    if(needsSave){await saveNow();if(saveError)return}
    const response=await fetch('/api/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'select',workspaceId:id})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){saveError=result.error||'HII could not switch workspaces.';return}
    workspaceMenu=false;selected=null;contextSelection=[];await load(id);
  }
  async function createNamedWorkspace(){
    const id=window.prompt('Name this workspace (lowercase letters, numbers, hyphens, or underscores):')?.trim();
    if(!id)return;
    if(saveInFlight){saveError='Wait for the current workspace save to finish before creating another workspace.';return}
    const needsSave=Boolean(saveTimer);
    if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined}
    if(needsSave){await saveNow();if(saveError)return}
    const response=await fetch('/api/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',workspaceId:id,select:true})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){saveError=result.error||'HII could not create the workspace.';return}
    workspaceMenu=false;selected=null;contextSelection=[];await load(id);
  }
  function patch(id:string,patch:Partial<WorkspaceNode>){const before=doc;doc={...doc,nodes:doc.nodes.map(n=>n.id===id?{...n,...patch,updatedAt:new Date().toISOString()}:n)};remember(before);persist();}
  function addSeeds(seeds:NodeSeed[],at:{x:number;y:number}){const before=doc;if(seeds.some(seed=>seed.type==='model'))ensureModelPane();for(const [index,seed] of seeds.entries()){const node=makeNode(seed,at.x+index*28,at.y+index*28,++doc.nextZ);doc={...doc,nodes:[...doc.nodes,node]};selected=node.id}remember(before);persist();}
  function spawn(type:string,payload:Record<string,unknown>={}){const typedPayload=type==='frame'?{sceneOrder:scenes.length+1,...payload}:payload;const seed=seedFor(type as WorkspaceNodeType,type==='browser'?{url:'https://duckduckgo.com',...typedPayload}:type==='terminal'?{sessionId:crypto.randomUUID(),...typedPayload}:typedPayload);const center={x:(-doc.viewport.x+innerWidth/2)/doc.viewport.zoom,y:(-doc.viewport.y+innerHeight/2)/doc.viewport.zoom};addSeeds([seed],{x:center.x-seed.w/2,y:center.y-seed.h/2});omnibar=false;query='';if(type==='context')void refreshContext();if(type==='board')void refreshBoard();}
  function workspacePoint(clientX:number,clientY:number){return{x:(clientX-doc.viewport.x)/doc.viewport.zoom,y:(clientY-doc.viewport.y)/doc.viewport.zoom}}
  async function summonComposer(at?:{x:number;y:number}){const now=Date.now();if(now-lastSummon<180)return;lastSummon=now;composerAt=at||workspacePoint(innerWidth/2,innerHeight/2);composerOpen=true;omnibar=false;await tick();composerInput?.focus();}
  function contextExcerpt(node:WorkspaceNode){
    const candidates=[node.payload.content,node.payload.text,node.payload.summary,node.payload.description,node.payload.markdown];
    return String(candidates.find(value=>typeof value==='string'&&value.trim())||'').replace(/\s+/g,' ').trim().slice(0,2400);
  }
  function contextItem(node:WorkspaceNode){
    return{
      id:node.id,
      title:workspaceNodeTitle(node),
      type:node.type,
      source:String(node.payload.path||node.payload.url||node.object?.source||'').slice(0,1000),
      excerpt:contextExcerpt(node),
      objectKind:String(node.object?.kind||''),
      owner:String(node.object?.owner||''),
      authority:String(node.objectRef?.authority||''),
      proofRefs:(node.object?.proofRefs||[]).slice(0,12)
    }
  }
  function createSpatialRun(intent:string,at:{x:number;y:number},parentId?:string,contextNodes:WorkspaceNode[]=[]){const before=doc;const title=intent.length>44?`${intent.slice(0,44)}…`:intent;const approvedContext=contextNodes.map(contextItem);let z=doc.nextZ;const intentSeed=seedFor('intent',{title:'your intent',text:intent,parentId,context:approvedContext}),intentNode=makeNode(intentSeed,at.x,at.y,++z),runSeed=seedFor('run',{title,prompt:intent,parentId:intentNode.id,autoStart:false,status:'waiting_approval',context:approvedContext,workspaceRoot:String(context?.identity?.repo||'/Users/ummi/hii'),model:'',maxSteps:8}),runNode=makeNode(runSeed,at.x,at.y+intentSeed.h+20,++z);doc={...doc,nextZ:z,nodes:[...doc.nodes,intentNode,runNode]};selected=runNode.id;contextSelection=[];remember(before);persist();}
  function submitIntent(){const intent=composerText.trim();if(!intent)return;const width=seedFor('intent').w;createSpatialRun(intent,{x:composerAt.x-width/2,y:composerAt.y-72},undefined,selectedContextNodes);composerText='';composerOpen=false;}
  async function openCommands(){omnibar=true;query='';await tick();commandInput?.focus();}
  function fitNodes(nodes:WorkspaceNode[],maxZoom=1){const rect=canvas?.getBoundingClientRect();if(!rect)return;const viewport=fitWorkspaceViewport(nodes,{width:rect.width,height:rect.height},{maxZoom});if(!viewport)return;doc={...doc,viewport};persist();}
  function fitAll(){fitNodes(doc.nodes);selected=null;contextSelection=[];currentSceneId=null;mapMenu=false;}
  function focusNode(node:WorkspaceNode){select(node);currentSceneId=node.frameId||null;fitNodes([node],1.25);omnibar=false;query='';}
  function sceneMembers(id:string){return workspaceSceneMembers(doc.nodes,id)}
  function fitScene(node:WorkspaceNode){const contents=sceneMembers(node.id);fitNodes(contents.length?[node,...contents]:[node],1.25);selected=node.id;contextSelection=[];currentSceneId=node.id;}
  function openScene(node:WorkspaceNode){fitScene(node);mapMenu=false;}
  function openAdjacentScene(direction:-1|1){const scene=adjacentWorkspaceScene(scenes,currentSceneId,direction);if(scene)openScene(scene)}
  function captureScene(id:string){const before=doc;const captured=assignNodesToFrame(doc,id);const now=new Date().toISOString();doc={...captured,nodes:captured.nodes.map(node=>node.id===id?{...node,updatedAt:now,object:{...node.object,kind:'scene',owner:'human',status:'ready',source:'HII spatial workspace',audit:[...(node.object?.audit||[]),{ts:now,actor:'human' as const,action:'captured workspace scene membership'}].slice(-20)}}:node)};currentSceneId=id;remember(before);persist();}
  function runCommand(command:string[]){if(command[0]==='fit'){fitAll();omnibar=false;query=''}else if(command[0]==='surface')spawn('surface',{title:command[1].replace('Open ',''),path:command[3],capabilityId:command[4]});else if(command[0]==='intent')void summonComposer();else if(command[0]==='upload'){omnibar=false;fileInput?.click()}else spawn(command[0]);}
  function followUp(node:WorkspaceNode,text:string){
    const intentSeed=seedFor('intent'),runSeed=seedFor('run');
    const at=findOpenWorkspacePosition(
      doc.nodes,
      {x:node.x+node.w+48,y:node.y},
      {w:Math.max(intentSeed.w,runSeed.w),h:intentSeed.h+20+runSeed.h}
    );
    createSpatialRun(text,at,node.id,[node]);
  }
  function completedRunNodes(runNode:WorkspaceNode,result:Record<string,unknown>){
    const runId=String(result.runId||runNode.id);
    if(doc.nodes.some(node=>node.object?.kind==='receipt'&&String(node.payload.runId||'')===runId))return;
    const receipt=(result.receipt&&typeof result.receipt==='object'?result.receipt:{}) as Record<string,unknown>;
    const job=(result.job&&typeof result.job==='object'?result.job:{}) as Record<string,unknown>;
    const contextItems=Array.isArray(result.context)?result.context:[];
    const checks=Array.isArray(receipt.verification)?receipt.verification.filter(check=>check&&typeof check==='object'&&(check as Record<string,unknown>).ok===true):[];
    const allArtifacts=Array.isArray(receipt.artifacts)?receipt.artifacts.map(String):[];
    const artifacts=allArtifacts.slice(0,6);
    const summary=String(receipt.summary||'The bounded workspace run completed and returned a receipt.');
    const before=doc;
    let z=doc.nextZ;
    const artifactWidth=artifacts.length?460:430;
    const artifactHeight=artifacts.length?340:260;
    const resultAt=findOpenWorkspacePosition(
      doc.nodes,
      {x:runNode.x+runNode.w+40,y:runNode.y},
      {w:artifactWidth+Math.max(0,artifacts.length-1)*28,h:artifactHeight+20+360}
    );
    const artifactNodes=artifacts.length
      ? artifacts.map((artifactPath,index)=>makeNode({type:'text',w:460,h:340,object:{kind:'artifact',owner:'aii',status:'completed',source:artifactPath,capabilityId:'hii.agent.workspace_run',runId,parentId:runNode.id,proofRefs:[String(result.receiptPath||''),artifactPath].filter(Boolean),audit:[{ts:new Date().toISOString(),actor:'hii',action:'materialized receipt-linked run artifact'}]},payload:{adapter:'run-artifact',title:artifactPath.split('/').at(-1)||'Run artifact',artifactPath,runId,receiptPath:String(result.receiptPath||''),summary}},resultAt.x+index*28,resultAt.y+index*28,++z))
      : [makeNode({type:'text',w:430,h:260,object:{kind:'artifact',owner:'aii',status:'completed',source:String(result.receiptPath||'HII workspace run receipt'),capabilityId:'hii.agent.workspace_run',runId,parentId:runNode.id,proofRefs:[String(result.receiptPath||'')].filter(Boolean),audit:[{ts:new Date().toISOString(),actor:'hii',action:'materialized verified run summary'}]},payload:{title:'Agent result',name:'verified artifact',summary,content:summary,path:'',runId}},resultAt.x,resultAt.y,++z)];
    const receiptAnchor=artifactNodes.at(-1)||runNode;
    const receiptSeed:NodeSeed={type:'note',w:430,h:360,object:{kind:'receipt',owner:'aii',status:'completed',source:'HII append-only workspace receipt',capabilityId:'hii.agent.workspace_run',runId,parentId:runNode.id,proofRefs:[String(result.receiptPath||'')].filter(Boolean),audit:[{ts:new Date().toISOString(),actor:'hii',action:'returned verified workspace receipt'}]},payload:{title:'Run receipt',summary,intent:String(result.intent||''),context:contextItems,checks,artifactCount:allArtifacts.length,materializedArtifactCount:artifacts.length,receiptPath:String(result.receiptPath||''),runId,status:String(job.status||'completed')}};
    const receiptNode=makeNode(receiptSeed,receiptAnchor.x,receiptAnchor.y+receiptAnchor.h+20,++z);
    doc={...doc,nextZ:z,nodes:[...doc.nodes,...artifactNodes,receiptNode]};
    selected=receiptNode.id;contextSelection=[receiptNode.id];remember(before);persist();fitNodes([runNode,...artifactNodes,receiptNode],1);
  }
  function materializeCapabilityDraft(runNode:WorkspaceNode,result:Record<string,unknown>){
    const id=String(result.id||'');
    if(!id||doc.nodes.some(node=>node.object?.kind==='capability'&&String(node.payload.skillId||'')===id))return;
    const before=doc;
    const relatedReceipt=doc.nodes.find(node=>node.object?.kind==='receipt'&&String(node.payload.runId||'')===String(result.runId||runNode.id));
    const seed:NodeSeed={type:'note',w:430,h:300,object:{kind:'capability',owner:'aii',status:'proposed',source:'HII proof-backed skill draft',capabilityId:id,runId:String(result.runId||runNode.id),parentId:relatedReceipt?.id||runNode.id,proofRefs:[String(result.receiptPath||''),String(result.bundle||'')].filter(Boolean),audit:[{ts:new Date().toISOString(),actor:'hii',action:'created proof-backed capability draft',note:'Operator review is required before registration.'}]},payload:{title:String(result.title||id),summary:'Verified work preserved as a draft capability. It is not executable until operator review and registration.',skillId:id,bundle:String(result.bundle||''),runId:String(result.runId||runNode.id)}};
    const anchor=relatedReceipt||runNode;
    const node=makeNode(seed,anchor.x,anchor.y+anchor.h+20,doc.nextZ+1);
    doc={...doc,nextZ:doc.nextZ+1,nodes:[...doc.nodes,node]};selected=node.id;contextSelection=[node.id];remember(before);persist();fitNodes([runNode,...(relatedReceipt?[relatedReceipt]:[]),node],1);
  }
  function openExplorer(event:MouseEvent){if(event.target!==canvas)return;const at=workspacePoint(event.clientX,event.clientY),seed=seedFor('explorer'),topLeft=workspacePoint(24,52),bottomRight=workspacePoint(innerWidth-24,innerHeight-72),x=Math.max(topLeft.x,Math.min(at.x-seed.w/2,bottomRight.x-seed.w)),y=Math.max(topLeft.y,Math.min(at.y-seed.h/2,bottomRight.y-seed.h));addSeeds([seed],{x,y});}
  function openSurface(id:string){const item=surfaceCatalog.find(candidate=>candidate.id===id);if(item)spawn('surface',{surface:item.id,title:item.title,path:item.path,capabilityId:item.capabilityId});}
  function close(id:string){const before=doc;const node=doc.nodes.find(candidate=>candidate.id===id);doc=node?.type==='frame'?removeFrame(doc,id):{...doc,nodes:doc.nodes.filter(n=>n.id!==id)};selected=null;contextSelection=contextSelection.filter(item=>item!==id);if(currentSceneId===id)currentSceneId=null;remember(before);persist();}
  function select(node:WorkspaceNode,additive=false){if(additive){const removing=contextSelection.includes(node.id);contextSelection=removing?contextSelection.filter(id=>id!==node.id):[...contextSelection,node.id];selected=removing?contextSelection.at(-1)||null:node.id}else{selected=node.id;contextSelection=[node.id]}if(node.z<doc.nextZ)doc={...doc,nextZ:doc.nextZ+1,nodes:doc.nodes.map(candidate=>candidate.id===node.id?{...candidate,z:doc.nextZ+1}:candidate)}}
  function drag(event:PointerEvent,node:WorkspaceNode){if((event.target as HTMLElement).closest('button,input,textarea,iframe,a,.scroll,.xterm'))return;event.preventDefault();if(event.shiftKey){select(node,true);return}const before=doc;select(node);const sx=event.clientX,sy=event.clientY,ox=node.x,oy=node.y;let changed=false;const move=(e:PointerEvent)=>{changed=true;doc=moveNodeAndFrameContents(doc,node.id,ox+(e.clientX-sx)/doc.viewport.zoom,oy+(e.clientY-sy)/doc.viewport.zoom)};const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up);if(changed){remember(before);persist()}};addEventListener('pointermove',move);addEventListener('pointerup',up);}
  function resize(event:PointerEvent,node:WorkspaceNode){event.preventDefault();event.stopPropagation();const before=doc,sx=event.clientX,sy=event.clientY,ow=node.w,oh=node.h;let changed=false;const move=(e:PointerEvent)=>{changed=true;doc={...doc,nodes:doc.nodes.map(candidate=>candidate.id===node.id?{...candidate,w:Math.max(140,ow+(e.clientX-sx)/doc.viewport.zoom),h:Math.max(80,oh+(e.clientY-sy)/doc.viewport.zoom)}:candidate)}};const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up);if(changed){if(node.type==='frame')doc=assignNodesToFrame(doc,node.id);remember(before);persist()}};addEventListener('pointermove',move);addEventListener('pointerup',up);}
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
  async function refreshDaemon(){try{const response=await fetch('/api/daemon');const result=await response.json();if(response.ok)daemon=result}catch{}}
  async function controlDaemon(action:string){if(daemonActionBusy)return;daemonActionBusy=true;try{const response=await fetch('/api/daemon',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const result=await response.json();if(!response.ok)throw new Error(result.error||'AII control failed.');daemon=result.snapshot;setTimeout(()=>void refreshDaemon(),800)}catch(error){saveError=error instanceof Error?error.message:'AII control failed.'}finally{daemonActionBusy=false}}
  function changeHistory(direction:'undo'|'redo'){const result=direction==='undo'?undoWorkspace(workspaceHistory,doc):redoWorkspace(workspaceHistory,doc);if(!result)return;doc=result.doc;workspaceHistory=result.history;selected=null;persist();}
  function keydown(event:KeyboardEvent){const editable=(event.target as Element)?.closest?.('input,textarea,[contenteditable]');const command=event.metaKey||event.ctrlKey;if(!editable&&command&&event.key.toLowerCase()==='z'){event.preventDefault();changeHistory(event.shiftKey?'redo':'undo');return}if(!editable&&command&&event.key.toLowerCase()==='y'){event.preventDefault();changeHistory('redo');return}if(!editable&&event.shiftKey&&event.key==='1'){event.preventDefault();fitAll();return}if(event.altKey&&event.code==='Space'&&!event.repeat){event.preventDefault();void summonComposer();return}if(command&&event.key.toLowerCase()==='k'){event.preventDefault();if(omnibar)omnibar=false;else void openCommands();}if(event.key==='Escape'){omnibar=false;composerOpen=false;}}
  async function drop(event:DragEvent){event.preventDefault();if(!event.dataTransfer)return;const at={x:(event.clientX-doc.viewport.x)/doc.viewport.zoom,y:(event.clientY-doc.viewport.y)/doc.viewport.zoom};addSeeds(await seedsFromDataTransfer(event.dataTransfer),at)}
  async function addFiles(files:File[]){const seeds=await seedsFromFiles(files);const center={x:(-doc.viewport.x+innerWidth/2)/doc.viewport.zoom,y:(-doc.viewport.y+innerHeight/2)/doc.viewport.zoom};addSeeds(seeds,{x:center.x-190,y:center.y-150})}
  onMount(()=>{let disposed=false;let unlistenSummon:(()=>void)|undefined;load();refreshContext();refreshBoard();refreshDaemon();const daemonTimer=setInterval(()=>void refreshDaemon(),10000);const move=(e:PointerEvent)=>mouse={x:e.clientX,y:e.clientY};const paste=(e:ClipboardEvent)=>{if((e.target as Element)?.closest?.('input,textarea,[contenteditable]'))return;const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();void addFiles(files);return}const text=e.clipboardData?.getData('text/plain');if(text){const at={x:(mouse.x-doc.viewport.x)/doc.viewport.zoom,y:(mouse.y-doc.viewport.y)/doc.viewport.zoom};addSeeds([seedFromString(text)],at)}};const nativeSummon=()=>void summonComposer();const summonFromUrl=new URLSearchParams(location.search).get('summon')==='1';if(summonFromUrl){history.replaceState(history.state,'',location.pathname);void summonComposer()}void import('@tauri-apps/api/core').then(async(core)=>{if(!core.isTauri())return;const{listen}=await import('@tauri-apps/api/event');const stop=await listen('hii://summon',nativeSummon);if(disposed)stop();else unlistenSummon=stop}).catch(()=>{});window.addEventListener('hii:summon',nativeSummon);window.addEventListener('keydown',keydown);window.addEventListener('pointermove',move);window.addEventListener('paste',paste);return()=>{disposed=true;clearInterval(daemonTimer);unlistenSummon?.();window.removeEventListener('hii:summon',nativeSummon);window.removeEventListener('keydown',keydown);window.removeEventListener('pointermove',move);window.removeEventListener('paste',paste)}});
</script>

{#if !data.enabled}<div class="hii-page flex min-h-[60vh] flex-col items-center justify-center gap-3"><p class="hii-kicker">surface off</p><h1 class="hii-page-title">HII is turned off</h1></div>
{:else}<main bind:this={canvas} bind:clientWidth={canvasWidth} bind:clientHeight={canvasHeight} class="absolute inset-0 touch-none overflow-hidden" on:pointerdown={pan} on:dblclick={openExplorer} on:wheel={trackpad} on:dragover|preventDefault on:drop={drop} style="background:#fff radial-gradient(circle,rgba(23,23,23,.08) 1px,transparent 1px);background-size:32px 32px">
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
  {#if contentOutsideView&&!saveError}
    <section data-workspace-ui role="status" aria-live="polite" class="absolute left-1/2 top-4 z-40 flex w-[min(560px,calc(100vw-240px))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-neutral-900/10 bg-white/95 p-2.5 pl-3 shadow-xl backdrop-blur-xl">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--hii-acid-green)] text-base text-neutral-950">↗</span>
      <div class="min-w-0 flex-1">
        <strong class="block truncate text-[13px] text-neutral-950">Your workspace is outside this view.</strong>
        <span class="block truncate font-mono text-[9px] uppercase tracking-[.08em] text-neutral-400">{doc.nodes.length} objects are safe · camera position preserved</span>
      </div>
      <button class="shrink-0 rounded-full bg-neutral-950 px-4 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-white" on:click={fitAll}>Show my work</button>
    </section>
  {/if}
  {#if contextSelection.length&&!composerOpen}
    <section data-workspace-ui role="status" class="absolute left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-blue-900/10 bg-white/95 p-1.5 pl-4 shadow-xl backdrop-blur-xl">
      <span class="font-mono text-[9px] uppercase tracking-[.1em] text-blue-700">{contextSelection.length} context object{contextSelection.length===1?'':'s'} selected</span>
      <button class="rounded-full bg-[var(--hii-electric-blue)] px-4 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-white" on:click={()=>void summonComposer()}>Give intent <kbd class="ml-1 text-white/60">⌥Space</kbd></button>
      <button class="rounded-full px-2 py-2 font-mono text-[9px] uppercase text-neutral-400 hover:text-neutral-900" aria-label="Clear context selection" on:click={()=>{contextSelection=[];selected=null}}>×</button>
    </section>
  {/if}
  <div class="absolute left-0 top-0 origin-top-left will-change-transform" style={`transform:translate(${doc.viewport.x}px,${doc.viewport.y}px) scale(${doc.viewport.zoom})`}>
    <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
      {#each connections as connection (connection.id)}
        <line x1={connection.x1} y1={connection.y1} x2={connection.x2} y2={connection.y2}
          stroke={connection.kind==='context'?'#8aa4c8':'#176bff'}
          stroke-width={connection.kind==='context'?1.5:2.5}
          stroke-dasharray={connection.kind==='context'?'6 7':'0'}
          opacity={connection.kind==='context'?0.55:0.72}
          vector-effect="non-scaling-stroke" />
      {/each}
    </svg>
    {#each doc.nodes as node (node.id)}<section role="group" aria-label={`${node.type} workspace node`} data-context-selected={contextSelection.includes(node.id)} class="group absolute left-0 top-0 flex flex-col overflow-hidden" class:hidden={Boolean(node.frameId&&collapsedFrameIds.has(node.frameId))} class:pointer-events-none={node.type==='frame'} class:ring-2={contextSelection.includes(node.id)||selected===node.id} class:ring-blue-500={contextSelection.includes(node.id)||selected===node.id} on:pointerdown={(event)=>drag(event,node)} style={`transform:translate(${node.x}px,${node.y}px);width:${node.w}px;height:${node.h}px;z-index:${Math.round(node.z)}`}>
      <header class="pointer-events-none absolute right-1 top-1 z-20"><span class="sr-only">{String(node.payload.title||node.type)}</span><button class="pointer-events-auto grid h-6 w-6 place-items-center rounded-full bg-neutral-950/80 text-sm text-white opacity-0 shadow-sm transition-opacity hover:bg-neutral-950 group-hover:opacity-100 focus:opacity-100" on:click={()=>close(node.id)} aria-label="close node">×</button></header>
      <div class="relative min-h-0 flex-1">
        {#if node.type==='frame'}<div class="h-full rounded-2xl border-2 border-dashed border-blue-500/60 bg-blue-50/10">
          <div class="pointer-events-auto flex h-10 cursor-move items-center gap-2 border-b border-blue-500/20 bg-blue-50/90 px-3 text-blue-950">
            <span class="shrink-0 rounded-full bg-blue-100 px-2 py-1 font-mono text-[8px] uppercase tracking-[.08em] text-blue-700">Scene {scenes.findIndex(scene=>scene.id===node.id)+1}</span>
            <input aria-label="Scene name" class="min-w-0 flex-1 bg-transparent text-[12px] font-semibold outline-none" value={String(node.payload.title||'Scene')} on:change={(event)=>patch(node.id,{payload:{...node.payload,title:event.currentTarget.value}})} />
            <span class="shrink-0 font-mono text-[8px] uppercase text-blue-700/60">{sceneMembers(node.id).length} objects</span>
            <button class="rounded-full px-2 py-1 font-mono text-[9px] uppercase hover:bg-white" on:click|stopPropagation={()=>captureScene(node.id)}>Capture</button>
            <button class="rounded-full px-2 py-1 font-mono text-[9px] uppercase hover:bg-white" on:click|stopPropagation={()=>fitScene(node)}>Go</button>
            <button class="rounded-full px-2 py-1 font-mono text-[9px] uppercase hover:bg-white" on:click|stopPropagation={()=>patch(node.id,{payload:{...node.payload,collapsed:node.payload.collapsed!==true}})}>{node.payload.collapsed===true?'Expand':'Collapse'}</button>
          </div>
        </div>
        {:else if node.object?.kind==='artifact'&&node.payload.adapter==='run-artifact'}<RunArtifactPane {node} onPatch={(next)=>patch(node.id,next)} />
        {:else if node.object?.kind==='capability'}<GovernedCapabilityPane {node} onPatch={(next)=>patch(node.id,next)} />
        {:else if ['artifact','receipt'].includes(node.object?.kind||'')}<GovernedResultPane {node} />
        {:else if ['note','text','canvas-text','ink','link','file','image','media','html','font'].includes(node.type)}<StaticNode {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} onSize={(size)=>patch(node.id,size)} />
        {:else if node.type==='intent'}<IntentPane {node} />
        {:else if node.type==='run'}<SpatialRunPane {node} onPatch={(next)=>patch(node.id,next)} onFollowUp={(text)=>followUp(node,text)} onComplete={(result)=>completedRunNodes(node,result)} onCapabilityDraft={(result)=>materializeCapabilityDraft(node,result)} />
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
      {#if selectedContextNodes.length}<div class="flex max-h-24 flex-wrap gap-1.5 overflow-auto border-b px-4 py-3">{#each selectedContextNodes as contextNode}<span class="max-w-[220px] truncate rounded-full bg-blue-50 px-2.5 py-1 font-mono text-[8px] uppercase tracking-[.06em] text-blue-700">{workspaceNodeTitle(contextNode)}</span>{/each}</div>{/if}
      <div class="flex items-start gap-3 p-4">
        <span class="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--hii-electric-blue)] text-sm text-white">✦</span>
        <textarea bind:this={composerInput} bind:value={composerText} rows="3" class="min-h-[76px] flex-1 resize-none bg-transparent text-[22px] font-medium leading-tight outline-none" placeholder="Tell HII what to create, explore, or do…" on:keydown={(event)=>{event.stopPropagation();if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitIntent()}}}></textarea>
      </div>
      <footer class="flex items-center justify-between border-t px-4 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400"><span>{selectedContextNodes.length} approved context · Shift Enter for a new line</span><button class="rounded-full bg-neutral-950 px-3 py-1.5 text-white disabled:opacity-30" disabled={!composerText.trim()} on:click={submitIntent}>prepare run ↵</button></footer>
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
  <div data-workspace-ui class="absolute left-5 top-4 z-40">
    <button class="rounded-full border border-neutral-900/10 bg-white/95 px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-neutral-700 shadow-lg backdrop-blur hover:border-neutral-900/25" on:click={()=>workspaceMenu=!workspaceMenu} aria-expanded={workspaceMenu} aria-haspopup="menu">{workspaceId} <span class="ml-2 text-neutral-400">⌄</span></button>
    {#if workspaceMenu}<div class="mt-2 min-w-[220px] overflow-hidden rounded-2xl border border-neutral-900/10 bg-white p-2 shadow-2xl" role="menu">
      <p class="px-3 py-2 font-mono text-[9px] uppercase tracking-[.12em] text-neutral-400">Workspaces</p>
      {#each workspaces as item}<button class="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] hover:bg-neutral-50" class:bg-blue-50={item.id===workspaceId} on:click={()=>void switchWorkspace(item.id)} role="menuitem"><span>{item.id}</span><span class="font-mono text-[9px] uppercase" class:text-red-600={item.status==='recovery'} class:text-neutral-400={item.status!=='recovery'}>{item.status==='recovery'?'recovery':item.id===workspaceId?'open':''}</span></button>{/each}
      <button class="mt-1 w-full rounded-xl border border-dashed border-neutral-300 px-3 py-2 text-left text-[12px] text-neutral-600 hover:border-neutral-500" on:click={()=>void createNamedWorkspace()} role="menuitem">+ New workspace</button>
    </div>{/if}
  </div>
  {#if doc.nodes.length}<div data-workspace-ui class="absolute bottom-5 left-5 z-40 flex gap-2">
    <button class="rounded-full border border-neutral-900/10 bg-white/95 px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-neutral-700 shadow-lg backdrop-blur hover:border-neutral-900/25" on:click={fitAll} aria-label="Fit all workspace content">Fit all <kbd class="ml-2 text-neutral-400">⇧1</kbd></button>
    <div class="relative">
      <button class="rounded-full border border-neutral-900/10 bg-white/95 px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-neutral-700 shadow-lg backdrop-blur hover:border-neutral-900/25" on:click={()=>mapMenu=!mapMenu} aria-label="Open workspace map" aria-expanded={mapMenu}>Map <kbd class="ml-2 text-neutral-400">{scenes.length}</kbd></button>
      {#if mapMenu}<section class="absolute bottom-12 left-0 w-[min(320px,calc(100vw-40px))] overflow-hidden rounded-2xl border border-neutral-900/10 bg-white p-2 shadow-2xl" aria-label="Workspace map">
        <div class="flex items-center justify-between px-3 py-2">
          <div><p class="font-mono text-[9px] uppercase tracking-[.12em] text-neutral-400">Workspace map</p><p class="mt-1 text-[12px] text-neutral-600">{doc.nodes.length} objects · {scenes.length} scenes</p></div>
          <button class="rounded-full bg-neutral-100 px-2 py-1 font-mono text-[9px] uppercase text-neutral-500" on:click={()=>mapMenu=false}>Close</button>
        </div>
        <div class="flex flex-wrap gap-1 px-3 py-2">{#each mapKinds as kind}<span class="rounded-full bg-neutral-100 px-2 py-1 font-mono text-[8px] uppercase text-neutral-500">{kind[0]} {kind[1]}</span>{/each}</div>
        {#if scenes.length}<div class="max-h-64 overflow-auto py-1"><div class="flex items-center justify-between px-3 pb-1 pt-2"><p class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Scenes</p><div class="flex gap-1"><button class="rounded-full bg-neutral-100 px-2 py-1 text-[10px]" aria-label="Previous scene" on:click={()=>openAdjacentScene(-1)}>←</button><button class="rounded-full bg-neutral-100 px-2 py-1 text-[10px]" aria-label="Next scene" on:click={()=>openAdjacentScene(1)}>→</button></div></div>{#each scenes as scene,index}<button class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left hover:bg-blue-50" class:bg-blue-50={scene.id===currentSceneId} on:click={()=>openScene(scene)}>
          <span class="mr-3 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-50 font-mono text-[9px] text-blue-700">{index+1}</span>
          <span class="min-w-0 flex-1"><strong class="block truncate text-[13px]">{String(scene.payload.title||'Untitled scene')}</strong><small class="block truncate font-mono text-[8px] uppercase text-neutral-400">{workspaceSceneTypeSummary(sceneMembers(scene.id))}</small></span>
          <span class="text-blue-600">↗</span>
        </button>{/each}</div>
        {:else}<div class="mx-1 rounded-xl bg-neutral-50 p-3"><p class="text-[12px] leading-5 text-neutral-500">Scenes name a group of objects and make a large workspace navigable.</p><button class="mt-3 font-mono text-[9px] uppercase text-blue-600 underline" on:click={()=>{mapMenu=false;spawn('frame')}}>Create a scene</button></div>{/if}
        {#if mapAnchors.length}<div class="mt-1 max-h-64 overflow-auto border-t py-1"><p class="px-3 pb-1 pt-2 font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Key places</p>{#each mapAnchors as node}<button class="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left hover:bg-blue-50" on:click={()=>{focusNode(node);mapMenu=false}}>
          <span class="min-w-0"><strong class="block truncate text-[12px]">{workspaceNodeTitle(node)}</strong><small class="font-mono text-[8px] uppercase text-neutral-400">{node.type}</small></span>
          <span class="text-blue-600">⌖</span>
        </button>{/each}</div>{/if}
      </section>{/if}
    </div>
  </div>{/if}
  <div data-workspace-ui class="absolute right-5 top-4 z-40">
    <button class="rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] shadow-lg backdrop-blur" class:border-transparent={['ready','busy'].includes(runtimeHealth.state)} class:bg-neutral-950={runtimeHealth.state==='ready'} class:bg-[var(--hii-electric-blue)]={runtimeHealth.state==='busy'} class:text-white={['ready','busy'].includes(runtimeHealth.state)} class:border-amber-300={runtimeHealth.state==='attention'} class:bg-amber-50={runtimeHealth.state==='attention'} class:text-amber-900={runtimeHealth.state==='attention'} class:border-red-200={runtimeHealth.state==='offline'} class:bg-white={runtimeHealth.state==='offline'} class:text-red-700={runtimeHealth.state==='offline'} on:click={()=>{healthOpen=!healthOpen;if(healthOpen)void refreshDaemon()}} aria-expanded={healthOpen} aria-haspopup="dialog">
      <i class="mr-2 inline-block h-2 w-2 rounded-full" class:animate-pulse={runtimeHealth.state==='busy'} class:bg-[var(--hii-acid-green)]={runtimeHealth.state==='ready'} class:bg-white={runtimeHealth.state==='busy'} class:bg-amber-500={runtimeHealth.state==='attention'} class:bg-red-500={runtimeHealth.state==='offline'}></i>{runtimeHealth.label}
    </button>
    {#if healthOpen}<div class="mt-2 w-[min(360px,calc(100vw-40px))] rounded-2xl border border-neutral-900/10 bg-white p-4 shadow-2xl" role="dialog" aria-label="AII runtime health">
      <div class="flex items-start justify-between gap-3"><div><p class="font-mono text-[8px] uppercase tracking-[.12em] text-neutral-400">Local runtime</p><h2 class="mt-1 text-[18px] font-semibold text-neutral-950">{runtimeHealth.label}</h2></div><button class="rounded-full bg-neutral-100 px-2 py-1 font-mono text-[8px] uppercase text-neutral-500" on:click={()=>healthOpen=false}>Close</button></div>
      <p class="mt-3 text-[12px] leading-5 text-neutral-600">{runtimeHealth.summary}</p>
      <div class="mt-3 grid grid-cols-3 gap-2 font-mono text-[8px] uppercase text-neutral-500"><div class="rounded-xl bg-neutral-50 p-2"><strong class="block text-[14px] text-neutral-900">{runtimeHealth.activeRuns}</strong>active runs</div><div class="rounded-xl bg-neutral-50 p-2"><strong class="block text-[14px] text-neutral-900">{runtimeHealth.queuedRuns}</strong>queued</div><div class="rounded-xl bg-neutral-50 p-2"><strong class="block text-[14px] text-neutral-900">{runtimeHealth.heartbeatAgeSeconds??'—'}</strong>heartbeat sec</div></div>
      <p class="mt-3 text-[10px] leading-4 text-neutral-400">{runtimeHealth.observedProcesses} observed workstation processes are available to the inspector but do not count as active HII agents.</p>
      <div class="mt-4 flex justify-end gap-2"><button class="rounded-full border px-3 py-1.5 font-mono text-[8px] uppercase text-neutral-600" on:click={refreshDaemon}>Refresh</button>{#if runtimeHealth.recoveryAction}<button class="rounded-full bg-neutral-950 px-3 py-1.5 font-mono text-[8px] uppercase text-white disabled:opacity-40" disabled={daemonActionBusy} on:click={()=>controlDaemon(runtimeHealth.recoveryAction)}>{daemonActionBusy?'Working…':runtimeHealth.recoveryLabel}</button>{/if}</div>
    </div>{/if}
  </div>
  {#if omnibar}<div class="absolute inset-0 z-50 bg-white/80 backdrop-blur-sm"><button type="button" class="absolute inset-0 cursor-default" aria-label="Close command palette" on:click={()=>omnibar=false}></button><div class="absolute left-1/2 top-1/2 w-[min(620px,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Create workspace object"><div class="flex items-center gap-3 border-b p-4"><span>⌘K</span><input bind:this={commandInput} bind:value={query} class="w-full outline-none" placeholder="Find anything, open a tool, or create…" /></div><div class="max-h-[420px] overflow-auto p-2">{#if nodeResults.length}<p class="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[.12em] text-neutral-400">On this canvas</p>{#each nodeResults as result}<button class="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-blue-50" on:click={()=>focusNode(result.node)}><span class="grid h-8 w-8 place-items-center rounded-lg bg-blue-50 text-sm text-blue-600">⌖</span><span class="min-w-0 flex-1"><strong class="block truncate">{result.title}</strong><small class="text-neutral-400">{result.node.type} · focus on canvas</small></span><kbd class="font-mono text-[10px] text-neutral-400">find</kbd></button>{/each}<div class="my-2 border-t"></div>{/if}{#each commands as command}<button class="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-neutral-50" on:click={()=>runCommand(command)}><span class="text-xl">{command[0]==='fit'?'⌖':command[0]==='surface'?'↗':'+'}</span><span class="flex-1"><strong class="block">{command[1]}</strong><small class="text-neutral-400">{command[2]}</small></span><kbd class="font-mono text-[10px] text-neutral-400">{command[0]==='fit'?'view':command[0]==='surface'?'open':command[0]==='upload'?'choose':'create'}</kbd></button>{/each}</div></div></div>{/if}
</main>{/if}
