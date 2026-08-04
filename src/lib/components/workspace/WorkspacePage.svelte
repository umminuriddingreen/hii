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
  import DevelopmentSessionPane from '$lib/components/workspace/DevelopmentSessionPane.svelte';
  import RunArtifactPane from '$lib/components/workspace/RunArtifactPane.svelte';
  import GovernedResultPane from '$lib/components/workspace/GovernedResultPane.svelte';
  import GovernedCapabilityPane from '$lib/components/workspace/GovernedCapabilityPane.svelte';
  import SurfacePane from '$lib/components/workspace/SurfacePane.svelte';
  import StaticNode from '$lib/components/workspace/StaticNode.svelte';
  import WorkspaceNavigator from '$lib/components/workspace/WorkspaceNavigator.svelte';
  import SystemSpace from '$lib/components/workspace/SystemSpace.svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';
  import EcosystemNav from '$lib/components/EcosystemNav.svelte';
  import type { WorkspaceDoc, WorkspaceNode, WorkspaceNodeType } from '@/lib/workspace/types';
  import { makeNode, seedFor, seedFromString, seedsFromDataTransfer, seedsFromFiles, type NodeSeed } from '@/lib/workspace/ingest';
  import { countWorkspaceNodesInViewport, fitWorkspaceViewport, panWorkspaceViewport, visibleWorkspaceNodeIds, zoomWorkspaceViewportAt } from '@/lib/workspace/viewport';
  import { searchWorkspaceNodes, workspaceNodeTitle } from '@/lib/workspace/search';
  import { assignNodesToFrame, moveNodeAndFrameContents, removeFrame } from '@/lib/workspace/frames';
  import { adjacentWorkspaceScene, workspaceSceneMembers, workspaceScenes } from '@/lib/workspace/scenes';
  import { emptyWorkspaceHistory, recordWorkspaceChange, redoWorkspace, undoWorkspace } from '@/lib/workspace/history';
  import { workspaceConnections, workspaceLinkConnections } from '@/lib/workspace/connections';
  import { INK_DEFAULT_COLOR, INK_DEFAULT_WIDTH, INK_PADDING, readStrokes, simplifyStroke, strokeBounds, translateStrokes, type InkStroke } from '@/lib/workspace/ink';
  import InkPane from '$lib/components/workspace/InkPane.svelte';
  import ImageLibrary from '$lib/components/workspace/ImageLibrary.svelte';
  import { workspaceImageLibrary, type LibraryImage } from '@/lib/workspace/image-library';
  import { scaleGestureDelta, trackPointerGesture } from '@/lib/workspace/gestures';
  import { rebaseWorkspaceDoc } from '@/lib/workspace/rebase';
  import { deleteWorkspaceNodes, duplicateWorkspaceNodes, linkWorkspaceNodes, nodesInLasso, nodesInMarquee, nudgeWorkspaceNodes, pasteWorkspaceNodes, readWorkspaceClipboard, unlinkWorkspaceNodes, writeWorkspaceClipboard } from '@/lib/workspace/selection';
  import { alignWorkspaceNodes, distributeWorkspaceNodes, snapWorkspaceRect, type AlignEdge, type SnapGuide } from '@/lib/workspace/snap';
  import { findOpenWorkspacePosition, tidyWorkspaceNodes } from '@/lib/workspace/layout';
  import { normalizeWorkspaceContextAnchor } from '@/lib/workspace/context-anchor';
  import { contactSheetContextItems, contactSheetItemSeed } from '@/lib/workspace/contact-sheet';
  import { organizeContactSheetReviewSet } from '@/lib/workspace/contact-sheet-scene';
  import { rebindPendingWorkspaceContext } from '@/lib/workspace/pending-context';
  import { organizeWorkspaceSelection } from '@/lib/workspace/organize';
  import { boardPatchForRunState, boardRunSyncKey } from '@/lib/workspace/board-run';
  import { interpretCanvasIntent, type CanvasIntent } from '@/lib/workspace/canvas-intent';

  export let data: { enabled: boolean };
  const surfaceCatalog = [
    { id:'knowledge', title:'Knowledge', path:'/knowledge', capabilityId:'hii.knowledge.workspace', detail:'canonical notes · systems · proof' },
    { id:'activate', title:'Activation', path:'/activate', capabilityId:'hii.agent.workspace_run', detail:'choose agent · approve context · run' },
    { id:'boards', title:'Boards', path:'/boards', capabilityId:'hii.board.task_kanban', detail:'bounded work · owners · blockers' },
    { id:'console', title:'Console', path:'/console', capabilityId:'hii.terminal.observe', detail:'agents · logs · receipts' }
  ];
  let doc:WorkspaceDoc={version:1,revision:0,updatedAt:new Date().toISOString(),viewport:{x:0,y:0,zoom:1},nextZ:1,nodes:[],links:[]};
  // The document as of the last successful sync. It is the baseline that lets a
  // save conflict be merged rather than reported as a dead end.
  let syncedDoc:WorkspaceDoc|null=null;
  let ready=false; let loadState:'loading'|'ready'|'recovery'='loading'; let loadError=''; let recoveryPath=''; let saveError='';
  let workspaceId='default'; let workspaces:Array<{id:string;selected:boolean;status:'ready'|'recovery';revision?:number}>=[]; let workspaceMenu=false;
  let selected:string|null=null; let contextSelection:string[]=[]; let omnibar=false; let query=''; let mapMenu=false; let currentSceneId:string|null=null; let organizationNotice=''; let canvasWidth=0; let canvasHeight=0; let saveTimer:ReturnType<typeof setTimeout>|undefined; let saveInFlight=false; let savePending=false;
  let context:any=null; let board:any[]=[]; let daemon:any=null; let healthOpen=false; let daemonActionBusy=false; let canvas:HTMLElement; let worldLayer:HTMLElement;
  // Deliberately not reactive: this is written on every pointermove, and letting
  // Svelte see it invalidated the whole component on every mouse movement.
  const pointer={x:400,y:300};
  const boardRunSync = new Map<string,string>();
  let commandInput:HTMLInputElement; let fileInput:HTMLInputElement;
  let composerOpen=false; let composerText=''; let composerInput:HTMLTextAreaElement; let composerAt={x:400,y:280}; let lastSummon=0;
  let ModelPaneComponent:any=null; let modelPanePromise:Promise<void>|null=null; let modelPaneError='';
  let workspaceHistory=emptyWorkspaceHistory();
  $: commands=[
    ['fit','Fit all content','take me to my stuff · ⇧1'],
    ['tidy',organizableSelection.length>1?'Tidy the selection':'Tidy the whole board','masonry pack · ⌘Z to undo'],
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
    ...(organizableSelection.length>1?[['organize','Make Scene from selection','exact membership · reversible']]:[]),
    ...(activeSelection.length?[
      ['duplicate','Duplicate selection','offset copies · ⌘D'],
      ['delete','Delete selection','removes objects · ⌘Z to undo']
    ]:[]),
    ...(organizableSelection.length>1?[
      ['align-left','Align left edges','tidy the selection'],
      ['align-center-x','Align horizontal centers','tidy the selection'],
      ['align-right','Align right edges','tidy the selection'],
      ['align-top','Align top edges','tidy the selection'],
      ['align-center-y','Align vertical centers','tidy the selection'],
      ['align-bottom','Align bottom edges','tidy the selection']
    ]:[]),
    ...(organizableSelection.length>2?[
      ['distribute-x','Distribute horizontally','even gaps · outermost stay put'],
      ['distribute-y','Distribute vertically','even gaps · outermost stay put']
    ]:[]),
    ['sound-field','Open South Berkeley sound field','modeled dBA']
  ].filter(item=>`${item[1]} ${item[2]}`.toLowerCase().includes(query.toLowerCase()));
  $: nodeResults=searchWorkspaceNodes(doc.nodes,query);
  $: collapsedFrameIds=new Set(doc.nodes.filter(node=>node.type==='frame'&&node.payload.collapsed===true).map(node=>node.id));
  $: scenes=workspaceScenes(doc.nodes);
  $: selectedContextNodes=contextSelection.map(id=>doc.nodes.find(node=>node.id===id)).filter((node):node is WorkspaceNode=>Boolean(node));
  $: organizableSelection=selectedContextNodes.filter(node=>node.type!=='frame');
  $: connections=workspaceConnections(doc.nodes);
  $: authoredLinks=workspaceLinkConnections(doc.nodes,doc.links??[]);
  $: visibleNodeCount=countWorkspaceNodesInViewport(doc.nodes,doc.viewport,{width:canvasWidth,height:canvasHeight});
  // Nodes keep their frame (geometry, selection, drag target) wherever they are,
  // but only nodes near the camera mount their pane. Off-screen iframes, xterm
  // terminals, and three.js scenes are what actually made a large board expensive.
  $: mountedIds=visibleWorkspaceNodeIds(doc.nodes,doc.viewport,{width:canvasWidth,height:canvasHeight},1);
  $: isMounted=(node:WorkspaceNode)=>!mountedIds||mountedIds.has(node.id);
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
      workspaceId=result.workspaceId||requestedWorkspaceId||'default';doc=result.workspace;syncedDoc=result.workspace;workspaceHistory=emptyWorkspaceHistory();selected=null;contextSelection=[];currentSceneId=null;loadState='ready';
      void refreshWorkspaces();
      if(doc.nodes.some(node=>node.type==='model'))ensureModelPane();
    }catch(error){
      loadState='recovery';loadError=error instanceof Error?error.message:'HII could not load this workspace.';
    }finally{ready=true;}
  }
  async function putWorkspace(){
    const response=await fetch('/api/workspace',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,workspace:doc,expectedRevision:doc.revision})});
    return{response,result:await response.json().catch(()=>({}))};
  }
  async function saveNow(){
    if(loadState!=='ready')return;
    if(saveInFlight){savePending=true;return;}
    saveInFlight=true;savePending=false;
    saveError='';
    try{
      let{response,result}=await putWorkspace();
      // Another writer (a second tab, the desktop shell, an agent run) advanced
      // the file. Merge onto their revision and try once more before giving up —
      // reporting "not saved" and stopping used to strand every later save too.
      if(response.status===409&&result.code==='WORKSPACE_REVISION_CONFLICT'){
        const fresh=await fetch(`/api/workspace?workspaceId=${encodeURIComponent(workspaceId)}`);
        const reloaded=await fresh.json().catch(()=>({}));
        if(fresh.ok&&reloaded.workspace){
          doc=rebaseWorkspaceDoc(doc,reloaded.workspace,syncedDoc??reloaded.workspace);
          ({response,result}=await putWorkspace());
        }
      }
      if(!response.ok){saveError=result.error||'HII could not save this workspace.';return;}
      doc={...doc,revision:result.workspace.revision,updatedAt:result.workspace.updatedAt};
      syncedDoc=doc;
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
    flushPatches();
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
    flushPatches();
    const needsSave=Boolean(saveTimer);
    if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined}
    if(needsSave){await saveNow();if(saveError)return}
    const response=await fetch('/api/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',workspaceId:id,select:true})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){saveError=result.error||'HII could not create the workspace.';return}
    workspaceMenu=false;selected=null;contextSelection=[];await load(id);
  }
  // Geometry-only patches can never change a node's context item, so they skip the
  // rebind check entirely. Everything else compares the derived fields directly
  // rather than stringifying two objects that each carry a 2400-char excerpt.
  const CONTEXT_NEUTRAL_KEYS=new Set(['x','y','w','h','z','frameId','updatedAt']);
  function touchesContext(next:Partial<WorkspaceNode>){return Object.keys(next).some(key=>!CONTEXT_NEUTRAL_KEYS.has(key))}
  function contextItemsEqual(a:ReturnType<typeof contextItem>,b:ReturnType<typeof contextItem>){
    if(a.title!==b.title||a.type!==b.type||a.source!==b.source||a.expectedSha256!==b.expectedSha256)return false;
    if(a.objectKind!==b.objectKind||a.owner!==b.owner||a.authority!==b.authority||a.excerpt!==b.excerpt)return false;
    if(a.proofRefs.length!==b.proofRefs.length||a.proofRefs.some((ref,index)=>ref!==b.proofRefs[index]))return false;
    return JSON.stringify(a.anchor)===JSON.stringify(b.anchor);
  }
  function patch(id:string,patch:Partial<WorkspaceNode>,historyBefore?:WorkspaceDoc){
    const before=historyBefore??doc;
    const current=doc.nodes.find(node=>node.id===id);
    if(!current)return;
    const updatedAt=new Date().toISOString();
    const next={...current,...patch,updatedAt};
    let nodes=doc.nodes.map(node=>node.id===id?next:node);
    if(touchesContext(patch)){
      const nextItem=contextItem(next);
      if(!contextItemsEqual(contextItem(current),nextItem)){
        nodes=rebindPendingWorkspaceContext(nodes,id,nextItem,updatedAt);
      }
    }
    doc={...doc,nodes};
    remember(before);
    persist();
  }
  // Typing in a note fired one patch — and therefore one full-document history
  // snapshot — per keystroke. Coalescing them makes undo work in edits rather than
  // characters, and keeps history memory proportional to edits made.
  const pendingPatches=new Map<string,{next:Partial<WorkspaceNode>;before:WorkspaceDoc;timer:ReturnType<typeof setTimeout>}>();
  function flushPatch(id:string){
    const entry=pendingPatches.get(id);
    if(!entry)return;
    clearTimeout(entry.timer);
    pendingPatches.delete(id);
    patch(id,entry.next,entry.before);
  }
  function flushPatches(){for(const id of [...pendingPatches.keys()])flushPatch(id)}
  function patchSoon(id:string,next:Partial<WorkspaceNode>,delay=200){
    const existing=pendingPatches.get(id);
    if(existing)clearTimeout(existing.timer);
    const before=existing?.before??doc;
    const merged:Partial<WorkspaceNode>=existing
      ?{...existing.next,...next,...(existing.next.payload||next.payload?{payload:{...(existing.next.payload||{}),...(next.payload||{})}}:{})}
      :next;
    pendingPatches.set(id,{next:merged,before,timer:setTimeout(()=>flushPatch(id),delay)});
  }
  function addSeeds(seeds:NodeSeed[],at:{x:number;y:number}){
    if(!seeds.length)return;
    if(seeds.some(seed=>seed.type==='model'))ensureModelPane();
    const before=doc;
    let z=doc.nextZ;
    // Build the whole batch first; reassigning `doc` inside the loop copied the
    // node array once per seed, which is quadratic for a multi-file drop.
    const created=seeds.map((seed,index)=>makeNode(seed,at.x+index*28,at.y+index*28,++z));
    doc={...doc,nextZ:z,nodes:[...doc.nodes,...created]};
    selected=created.at(-1)?.id??selected;
    remember(before);persist();
  }
  function promoteContactSheetItem(sheet:WorkspaceNode,item:Record<string,unknown>,label?:string){
    const sha256=String(item.sha256||'');
    const existing=doc.nodes.find(node=>node.object?.parentId===sheet.id&&String(node.payload.sha256||'')===sha256);
    if(existing){select(existing);contextSelection=[existing.id];fitNodes([existing],1);return}
    const before=doc,seed=contactSheetItemSeed(item,sheet.id,label);
    const at=findOpenWorkspacePosition(doc.nodes,{x:sheet.x+sheet.w+32,y:sheet.y},{w:seed.w,h:seed.h});
    const promoted=makeNode(seed,at.x,at.y,doc.nextZ+1);
    doc={...doc,nextZ:doc.nextZ+1,nodes:[...doc.nodes,promoted]};selected=promoted.id;contextSelection=[promoted.id];remember(before);persist();fitNodes([sheet,promoted],1);
  }
  function organizeContactSheetSelection(sheet:WorkspaceNode){
    const before=doc;
    try{
      const organized=organizeContactSheetReviewSet(doc,sheet);
      if(!organized){saveError='Select at least two exact references before making a Scene.';return}
      if(!organized.created){fitScene(organized.scene);organizationNotice=`${workspaceNodeTitle(organized.scene)} already holds this exact review set.`;return}
      doc=organized.doc;selected=organized.scene.id;contextSelection=[];currentSceneId=organized.scene.id;
      organizationNotice=`${workspaceNodeTitle(organized.scene)} now holds ${organized.memberIds.length} source-linked references.`;
      remember(before);persist();mapMenu=false;fitNodes([organized.scene,...doc.nodes.filter(node=>organized.memberIds.includes(node.id))],1);
    }catch(error){saveError=error instanceof Error?error.message:'HII could not organize this review set.'}
  }
  function spawn(type:string,payload:Record<string,unknown>={}){const typedPayload=type==='frame'?{sceneOrder:scenes.length+1,...payload}:payload;const seed=seedFor(type as WorkspaceNodeType,type==='browser'?{url:'https://www.google.com',...typedPayload}:type==='terminal'?{sessionId:crypto.randomUUID(),...typedPayload}:typedPayload);const center={x:(-doc.viewport.x+innerWidth/2)/doc.viewport.zoom,y:(-doc.viewport.y+innerHeight/2)/doc.viewport.zoom};addSeeds([seed],{x:center.x-seed.w/2,y:center.y-seed.h/2});omnibar=false;query='';if(type==='context')void refreshContext();if(type==='board')void refreshBoard();}
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
      expectedSha256:String(node.payload.sha256||'').slice(0,64),
      anchor:normalizeWorkspaceContextAnchor(node.payload.contextAnchor),
      excerpt:contextExcerpt(node),
      objectKind:String(node.object?.kind||''),
      owner:String(node.object?.owner||''),
      authority:String(node.objectRef?.authority||''),
      proofRefs:(node.object?.proofRefs||[]).slice(0,12)
    }
  }
  function contextItemsForNode(node:WorkspaceNode){if(node.payload.adapter==='contact-sheet'){const selected=contactSheetContextItems({nodeId:node.id,items:node.payload.items,selectedItems:node.payload.selectedItems,itemLabels:node.payload.itemLabels,proofRefs:node.object?.proofRefs});if(selected.length)return selected}return[contextItem(node)]}
  function createSpatialRun(intent:string,at:{x:number;y:number},parentId?:string,contextNodes:WorkspaceNode[]=[]){const before=doc;const title=intent.length>44?`${intent.slice(0,44)}…`:intent;const approvedContext=contextNodes.flatMap(contextItemsForNode).slice(0,24);let z=doc.nextZ;const intentSeed=seedFor('intent',{title:'your intent',text:intent,parentId,context:approvedContext}),intentNode=makeNode(intentSeed,at.x,at.y,++z),runSeed=seedFor('run',{title,prompt:intent,parentId:intentNode.id,autoStart:false,status:'waiting_approval',context:approvedContext,workspaceRoot:String(context?.identity?.repo||'/Users/ummi/hii'),model:'',maxSteps:8}),runNode=makeNode(runSeed,at.x,at.y+intentSeed.h+20,++z);doc={...doc,nextZ:z,nodes:[...doc.nodes,intentNode,runNode]};selected=runNode.id;contextSelection=[];remember(before);persist();}
  function openDevelopmentSession(){
    const existing=doc.nodes.find(node=>node.type==='run'&&node.payload.developmentSession===true&&!['completed','failed','cancelled'].includes(String(node.payload.status||'')));
    if(existing){focusNode(existing);return}
    const before=doc;
    const prompt='Develop HII from inside this governed HII canvas object. Work only in /Users/ummi/hii. Start or reuse the Svelte development server on 127.0.0.1:5173 so web UI changes hot-load in this object, make the requested bounded change, run relevant tests, and attach proof to the run. Do not push or deploy. Web and Svelte changes use HMR. If Rust or Tauri changes are required, do not overwrite /Applications/HII.app; build and relaunch only a separate /Applications/HII Preview.app and report the rebuild boundary.';
    const at=findOpenWorkspacePosition(doc.nodes,workspacePoint(innerWidth/2-520,innerHeight/2-360),{w:1040,h:720});
    const seed=seedFor('run',{title:'HII development session',prompt,developmentSession:true,previewUrl:'http://127.0.0.1:5173/workspace',autoStart:false,status:'waiting_approval',context:[],workspaceRoot:'/Users/ummi/hii',model:'',maxSteps:16});
    seed.w=1040;seed.h=720;
    seed.object={...seed.object,kind:'run',source:'HII governed self-development canvas object',audit:[...(seed.object?.audit||[]),{ts:new Date().toISOString(),actor:'human',action:'opened HII self-development session'}]};
    const node=makeNode(seed,at.x,at.y,doc.nextZ+1);
    doc={...doc,nextZ:doc.nextZ+1,nodes:[...doc.nodes,node]};selected=node.id;contextSelection=[];remember(before);persist();fitNodes([node],1);
  }
  async function updateBoardTask(id:string,patch:Record<string,unknown>){
    const response=await fetch('/api/board/tasks',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id,...patch})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'HII could not update the governed board.');
    board=board.map(task=>task.id===id?result.task:task);
    return result.task;
  }
  function createBoardRun(task:any,boardNode:WorkspaceNode){
    const retryable=task.lane==='blocked'&&['failed','cancelled'].includes(String(task.runStatus||''));
    if(task.reviewState==='proposed'||(!['next','doing'].includes(task.lane)&&!retryable)){
      saveError='Approve this task into next or doing before preparing execution.';
      return;
    }
    const existing=doc.nodes.find(node=>
      node.type==='run'
      && String(node.payload.boardTaskId||'')===String(task.id||'')
      && !['failed','cancelled'].includes(String(node.payload.status||node.object?.status||''))
    );
    if(existing){focusNode(existing);return}
    if(task.runId&&!['failed','cancelled'].includes(String(task.runStatus||''))){
      saveError=`This task is already linked to run ${String(task.runId).slice(0,12)}. Open the workspace that owns that run instead of duplicating it.`;
      return;
    }
    const before=doc;
    const intentSeed=seedFor('intent');
    const runSeed=seedFor('run');
    const at=findOpenWorkspacePosition(
      doc.nodes,
      {x:boardNode.x+boardNode.w+48,y:boardNode.y},
      {w:Math.max(intentSeed.w,runSeed.w),h:intentSeed.h+20+runSeed.h}
    );
    const approvedContext=[{
      id:`board:${String(task.id||'')}`,
      title:String(task.title||'Approved board task'),
      type:'board-task',
      source:'HII append-only task ledger',
      excerpt:String(task.notes||'').slice(0,2400),
      objectKind:'task',
      owner:String(task.owner||'main agent'),
      authority:'hii-runtime',
      proofRefs:[`board-task:${String(task.id||'')}`]
    }];
    let z=doc.nextZ;
    const boardIntentSeed=seedFor('intent',{
      title:'approved board intent',
      text:String(task.title||''),
      parentId:boardNode.id,
      boardTaskId:String(task.id||''),
      context:approvedContext
    });
    boardIntentSeed.object={
      ...boardIntentSeed.object,
      kind:'intent',
      owner:'human',
      status:'approved',
      source:'HII approved board task',
      parentId:boardNode.id,
      proofRefs:[`board-task:${String(task.id||'')}`],
      audit:[...(boardIntentSeed.object?.audit||[]),{
        ts:new Date().toISOString(),
        actor:'human',
        action:'prepared approved board task for bounded execution'
      }]
    };
    const intentNode=makeNode(boardIntentSeed,at.x,at.y,++z);
    const boardRunSeed=seedFor('run',{
      title:String(task.title||'Approved board task').slice(0,44),
      prompt:String(task.title||''),
      parentId:intentNode.id,
      boardTaskId:String(task.id||''),
      autoStart:false,
      status:'waiting_approval',
      context:approvedContext,
      workspaceRoot:String(task.coordinate||context?.identity?.repo||'/Users/ummi/hii'),
      model:'',
      maxSteps:8
    });
    const runNode=makeNode(boardRunSeed,at.x,at.y+boardIntentSeed.h+20,++z);
    doc={...doc,nextZ:z,nodes:[...doc.nodes,intentNode,runNode]};
    selected=runNode.id;
    contextSelection=[intentNode.id];
    remember(before);
    persist();
    fitNodes([intentNode,runNode],1);
    const syncKey=boardRunSyncKey({status:'waiting_approval',runId:runNode.id});
    boardRunSync.set(String(task.id||''),syncKey);
    void updateBoardTask(
      String(task.id||''),
      boardPatchForRunState({
        status:'waiting_approval',
        runId:runNode.id,
        currentLane:task.lane
      })
    ).catch(error=>{saveError=error instanceof Error?error.message:'The run was prepared, but its board link was not recorded.'});
  }
  function patchRunNode(node:WorkspaceNode,next:Partial<WorkspaceNode>){
    patch(node.id,next);
    const nextPayload={...node.payload,...(next.payload||{})};
    const boardTaskId=String(nextPayload.boardTaskId||'');
    const runStatus=String(nextPayload.status||'');
    if(!boardTaskId||!['waiting_approval','queued','running','completed','failed','cancelled'].includes(runStatus))return;
    const runId=String(nextPayload.runId||next.object?.runId||node.id);
    const receiptRef=String(nextPayload.receiptPath||'');
    const syncKey=boardRunSyncKey({status:runStatus,runId,receiptRef});
    if(boardRunSync.get(boardTaskId)===syncKey)return;
    boardRunSync.set(boardTaskId,syncKey);
    const boardTask=board.find(task=>String(task.id||'')===boardTaskId);
    let boardPatch:Record<string,unknown>;
    try{
      boardPatch=boardPatchForRunState({
        status:runStatus,
        runId,
        receiptRef,
        currentLane:boardTask?.lane
      });
    }catch(error){
      boardRunSync.delete(boardTaskId);
      saveError=error instanceof Error?error.message:'The run state could not be linked to the board.';
      return;
    }
    void updateBoardTask(boardTaskId,boardPatch).catch(error=>{
      boardRunSync.delete(boardTaskId);
      saveError=error instanceof Error?error.message:'The run changed, but its board state was not recorded.';
    });
  }
  function executeCanvasIntent(intent:CanvasIntent){
    if(intent.kind==='clarify'){organizationNotice=intent.message;return}
    if(intent.kind==='fit-all'){fitAll();return}
    if(intent.kind==='focus'){const node=doc.nodes.find(candidate=>candidate.id===intent.nodeId);if(node)focusNode(node);return}
    contextSelection=intent.targetIds;selected=intent.targetIds.at(-1)??null;
    if(intent.kind==='delete')deleteSelection();
    else if(intent.kind==='duplicate')duplicateSelection();
    else if(intent.kind==='move')nudgeSelection(intent.dx,intent.dy);
    else tidyNodeIds(intent.targetIds);
  }
  function submitNaturalLanguage(intent:string,at:{x:number;y:number}){
    const visibleIds=[...(visibleWorkspaceNodeIds(doc.nodes,doc.viewport,{width:canvasWidth,height:canvasHeight},0)??new Set<string>())];
    const canvasIntent=interpretCanvasIntent(intent,{nodes:doc.nodes,selectedIds:activeSelection,visibleIds});
    if(canvasIntent){executeCanvasIntent(canvasIntent);return}
    const width=seedFor('intent').w;createSpatialRun(intent,{x:at.x-width/2,y:at.y-72},undefined,selectedContextNodes);
  }
  function submitIntent(){
    const intent=composerText.trim();if(!intent)return;
    submitNaturalLanguage(intent,composerAt);composerText='';composerOpen=false;
  }
  function submitOmnibar(){
    const intent=query.trim();if(!intent)return;
    submitNaturalLanguage(intent,workspacePoint(innerWidth/2,innerHeight/2));omnibar=false;query='';
  }
  async function openCommands(){omnibar=true;query='';await tick();commandInput?.focus();}
  function fitNodes(nodes:WorkspaceNode[],maxZoom=1){const rect=canvas?.getBoundingClientRect();if(!rect)return;const viewport=fitWorkspaceViewport(nodes,{width:rect.width,height:rect.height},{maxZoom});if(!viewport)return;doc={...doc,viewport};persist();}
  function fitAll(){fitNodes(doc.nodes);selected=null;contextSelection=[];currentSceneId=null;mapMenu=false;}
  function focusNode(node:WorkspaceNode){select(node);currentSceneId=node.frameId||null;fitNodes([node],1.25);omnibar=false;query='';}
  function selectShownNodes(nodes:WorkspaceNode[]){const ids=[...new Set(nodes.filter(node=>node.type!=='frame').map(node=>node.id))];if(!ids.length)return;organizationNotice='';contextSelection=ids;selected=ids.at(-1)||null;}
  function sceneMembers(id:string){return workspaceSceneMembers(doc.nodes,id)}
  function fitScene(node:WorkspaceNode){const contents=sceneMembers(node.id);fitNodes(contents.length?[node,...contents]:[node],1.25);selected=node.id;contextSelection=[];currentSceneId=node.id;}
  function openScene(node:WorkspaceNode){fitScene(node);mapMenu=false;}
  function openAdjacentScene(direction:-1|1){const scene=adjacentWorkspaceScene(scenes,currentSceneId,direction);if(scene)openScene(scene)}
  function captureScene(id:string){const before=doc;const captured=assignNodesToFrame(doc,id);const now=new Date().toISOString();doc={...captured,nodes:captured.nodes.map(node=>node.id===id?{...node,updatedAt:now,object:{...node.object,kind:'scene',owner:'human',status:'ready',source:'HII spatial workspace',audit:[...(node.object?.audit||[]),{ts:now,actor:'human' as const,action:'captured workspace scene membership'}].slice(-20)}}:node)};currentSceneId=id;remember(before);persist();}
  function organizeSelection(){
    const before=doc;
    const organized=organizeWorkspaceSelection(doc,contextSelection);
    if(!organized)return;
    doc=organized.doc;
    selected=organized.scene.id;
    contextSelection=[];
    currentSceneId=organized.scene.id;
    organizationNotice=`${workspaceNodeTitle(organized.scene)} now holds ${organized.organizedIds.length} selected objects.`;
    remember(before);
    persist();
    mapMenu=false;omnibar=false;query='';
    fitNodes([organized.scene,...doc.nodes.filter(node=>organized.organizedIds.includes(node.id))],1);
  }
  function runCommand(command:string[]){
    const close=()=>{omnibar=false;query=''};
    if(command[0]==='tidy'){tidySelection();close();return}
    if(command[0]==='duplicate'){duplicateSelection();close();return}
    if(command[0]==='delete'){deleteSelection();close();return}
    if(command[0].startsWith('align-')){alignSelection(command[0].slice(6) as AlignEdge);close();return}
    if(command[0].startsWith('distribute-')){distributeSelection(command[0].slice(11) as 'x'|'y');close();return}
    if(command[0]==='fit'){fitAll();omnibar=false;query=''}else if(command[0]==='organize')organizeSelection();else if(command[0]==='surface')spawn('surface',{title:command[1].replace('Open ',''),path:command[3],capabilityId:command[4]});else if(command[0]==='intent')void summonComposer();else if(command[0]==='upload'){omnibar=false;fileInput?.click()}else spawn(command[0]);}
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
  // --- Editing primitives ------------------------------------------------------
  // Everything here works on `activeSelection`: the multi-select if there is one,
  // otherwise whatever single node is focused.
  $: activeSelection=contextSelection.length?contextSelection:selected?[selected]:[];
  function deleteSelection(){
    if(!activeSelection.length)return;
    const before=doc;
    doc=deleteWorkspaceNodes(doc,activeSelection);
    if(currentSceneId&&activeSelection.includes(currentSceneId))currentSceneId=null;
    selected=null;contextSelection=[];
    remember(before);persist();
  }
  function duplicateSelection(){
    if(!activeSelection.length)return;
    const before=doc;
    const result=duplicateWorkspaceNodes(doc,activeSelection);
    if(!result.createdIds.length)return;
    doc=result.doc;contextSelection=result.createdIds;selected=result.createdIds.at(-1)??null;
    remember(before);persist();
  }
  function nudgeSelection(dx:number,dy:number){
    if(!activeSelection.length)return;
    const before=doc;
    doc=nudgeWorkspaceNodes(doc,activeSelection,dx,dy);
    remember(before);persist();
  }
  function selectAll(){
    const ids=doc.nodes.filter(node=>node.type!=='frame'&&!(node.frameId&&collapsedFrameIds.has(node.frameId))).map(node=>node.id);
    if(!ids.length)return;
    organizationNotice='';contextSelection=ids;selected=ids.at(-1)??null;
  }
  async function copySelection(cut=false){
    if(!activeSelection.length)return;
    try{await navigator.clipboard.writeText(writeWorkspaceClipboard(doc,activeSelection))}
    catch{saveError='HII could not reach the system clipboard.';return}
    if(cut)deleteSelection();
  }
  function pasteNodes(nodes:WorkspaceNode[],at:{x:number;y:number}){
    const before=doc;
    const result=pasteWorkspaceNodes(doc,nodes,at);
    if(!result.createdIds.length)return;
    if(nodes.some(node=>node.type==='model'))ensureModelPane();
    doc=result.doc;contextSelection=result.createdIds;selected=result.createdIds.at(-1)??null;
    remember(before);persist();
  }
  function applyMoves(moves:Map<string,{x:number;y:number}>,notice:string){
    if(!moves.size)return;
    const before=doc;
    const updatedAt=new Date().toISOString();
    doc={...doc,nodes:doc.nodes.map(node=>moves.has(node.id)?{...node,...moves.get(node.id)!,updatedAt}:node)};
    organizationNotice=notice;
    remember(before);persist();
  }
  function tidySelection(){
    // With nothing selected, tidy is a whole-board command — that is the case
    // where a wall of dropped images most needs it.
    const targets=organizableSelection.length>1?organizableSelection:doc.nodes.filter(node=>node.type!=='frame');
    const moves=tidyWorkspaceNodes(targets);
    applyMoves(moves,`Tidied ${moves.size} objects into a packed board.`);
    if(moves.size)fitNodes(doc.nodes.filter(node=>moves.has(node.id)),1);
  }
  function tidyNodeIds(ids:string[]){
    const targets=doc.nodes.filter(node=>ids.includes(node.id)&&node.type!=='frame');
    const moves=tidyWorkspaceNodes(targets);
    applyMoves(moves,`Tidied ${moves.size} objects into a packed board.`);
    if(moves.size)fitNodes(doc.nodes.filter(node=>moves.has(node.id)),1);
  }
  function alignSelection(edge:AlignEdge){applyMoves(alignWorkspaceNodes(organizableSelection,edge),`Aligned ${organizableSelection.length} objects.`)}
  function distributeSelection(axis:'x'|'y'){applyMoves(distributeWorkspaceNodes(organizableSelection,axis),`Distributed ${organizableSelection.length} objects.`)}
  // --- Image library ---------------------------------------------------------------
  let libraryOpen=false;
  // Only recomputed while the panel is open — scanning every contact sheet on
  // each document change would undo the point of the derivation work above.
  $: libraryImages=libraryOpen?workspaceImageLibrary(doc.nodes):[];
  function placeLibraryImage(image:LibraryImage,at:{clientX:number;clientY:number}|null){
    const seed=contactSheetItemSeed(image,image.sourceId,image.name);
    const point=at?workspacePoint(at.clientX,at.clientY):workspacePoint(innerWidth/2,innerHeight/2);
    const open=findOpenWorkspacePosition(doc.nodes,{x:point.x-seed.w/2,y:point.y-seed.h/2},{w:seed.w,h:seed.h});
    addSeeds([seed],open);
  }
  // --- Freehand ink ---------------------------------------------------------------
  // The pen is a mode: while it is on, dragging the canvas draws instead of
  // panning. Strokes land in one ink node per drawing session, so a sketch is a
  // single object that can be moved, duplicated, and deleted as a unit.
  let penActive=false;
  let inkNodeId:string|null=null;
  // The in-progress stroke is previewed in world coordinates as a single SVG
  // polyline. Committing it is what turns it into node-relative ink.
  let livePreview:number[]|null=null;
  function togglePen(){penActive=!penActive;if(!penActive)inkNodeId=null}
  function draw(event:PointerEvent){
    event.preventDefault();
    const start=workspacePoint(event.clientX,event.clientY);
    const target=inkNodeId?doc.nodes.find(candidate=>candidate.id===inkNodeId):undefined;
    // Points are relative to the ink node's origin. A brand-new drawing anchors
    // its node at the first point, less the padding the pane leaves for width.
    const origin=target?{x:target.x,y:target.y}:{x:start.x-INK_PADDING,y:start.y-INK_PADDING};
    const world=[start.x,start.y];
    livePreview=[...world];
    trackPointerGesture(event,{
      onMove:(delta)=>{
        const{dx,dy}=scaleGestureDelta(delta,doc.viewport.zoom);
        world.push(start.x+dx,start.y+dy);
        livePreview=[...world];
      },
      onEnd:(_delta,moved)=>{
        livePreview=null;
        if(!moved||world.length<4)return;
        const relative=world.map((value,index)=>index%2===0?value-origin.x:value-origin.y);
        commitStroke({points:simplifyStroke(relative),color:INK_DEFAULT_COLOR,width:INK_DEFAULT_WIDTH},origin);
      },
      onCancel:()=>{livePreview=null}
    });
  }
  function commitStroke(stroke:InkStroke,origin:{x:number;y:number}){
    const before=doc;
    const existing=inkNodeId?doc.nodes.find(candidate=>candidate.id===inkNodeId):undefined;
    const strokes=[...(existing?readStrokes(existing.payload.strokes):[]),stroke];
    // Grow the node to whatever the strokes now cover. Bounds can move up or
    // left, so points are re-based to keep them relative to the new origin.
    const bounds=strokeBounds(strokes)??{x:0,y:0,w:240,h:180};
    const rebased=translateStrokes(strokes,-bounds.x,-bounds.y);
    const geometry={x:origin.x+bounds.x,y:origin.y+bounds.y,w:Math.max(40,bounds.w),h:Math.max(28,bounds.h)};
    if(existing){
      doc={...doc,nodes:doc.nodes.map(candidate=>candidate.id===existing.id
        ?{...candidate,...geometry,updatedAt:new Date().toISOString(),payload:{...candidate.payload,strokes:rebased}}
        :candidate)};
    }else{
      const seed=seedFor('ink',{strokes:rebased,title:'Ink'});
      const created=makeNode({...seed,w:geometry.w,h:geometry.h},geometry.x,geometry.y,doc.nextZ+1);
      doc={...doc,nextZ:doc.nextZ+1,nodes:[...doc.nodes,created]};
      inkNodeId=created.id;
    }
    remember(before);persist();
  }
  // --- Drawn connectors ----------------------------------------------------------
  let linkDraft:{fromId:string;x1:number;y1:number;x2:number;y2:number}|null=null;
  let selectedLinkId:string|null=null;
  /** Which node sits under a screen point, topmost first, ignoring scene frames. */
  function nodeAtPoint(clientX:number,clientY:number,excludeId:string){
    const at=workspacePoint(clientX,clientY);
    return [...doc.nodes]
      .filter(node=>node.id!==excludeId&&node.type!=='frame'&&!(node.frameId&&collapsedFrameIds.has(node.frameId)))
      .sort((a,b)=>b.z-a.z)
      .find(node=>at.x>=node.x&&at.x<=node.x+node.w&&at.y>=node.y&&at.y<=node.y+node.h)??null;
  }
  function startLink(event:PointerEvent,node:WorkspaceNode){
    event.preventDefault();event.stopPropagation();
    const origin={x:node.x+node.w/2,y:node.y+node.h/2};
    const start=workspacePoint(event.clientX,event.clientY);
    linkDraft={fromId:node.id,x1:origin.x,y1:origin.y,x2:start.x,y2:start.y};
    trackPointerGesture(event,{
      onMove:(delta)=>{
        const{dx,dy}=scaleGestureDelta(delta,doc.viewport.zoom);
        linkTargetId=nodeAtPoint(event.clientX+delta.dx,event.clientY+delta.dy,node.id)?.id??null;
        linkDraft={fromId:node.id,x1:origin.x,y1:origin.y,x2:start.x+dx,y2:start.y+dy};
      },
      onEnd:(delta,moved)=>{
        const target=moved?nodeAtPoint(event.clientX+delta.dx,event.clientY+delta.dy,node.id):null;
        linkDraft=null;linkTargetId=null;
        if(!target)return;
        const before=doc;
        const next=linkWorkspaceNodes(doc,node.id,target.id);
        if(next===doc)return; // self-link or already connected
        doc=next;remember(before);persist();
      },
      onCancel:()=>{linkDraft=null;linkTargetId=null}
    });
  }
  let linkTargetId:string|null=null;
  function deleteLink(id:string){
    const before=doc;
    doc=unlinkWorkspaceNodes(doc,[id]);
    selectedLinkId=null;
    remember(before);persist();
  }
  // --- Marquee and lasso ---------------------------------------------------------
  // Both are the same gesture. A rectangle is the precise tool; holding Alt turns
  // it into a freeform lasso, which is what a scattered cluster of references
  // actually needs.
  let marquee:{x:number;y:number;w:number;h:number}|null=null;
  let lassoPath:number[]|null=null;
  function startMarquee(event:PointerEvent){
    const origin=workspacePoint(event.clientX,event.clientY);
    const additive=event.shiftKey;
    const lasso=event.altKey;
    const beforeSelection=[...contextSelection];
    const path=[origin.x,origin.y];
    trackPointerGesture(event,{
      onMove:(delta)=>{
        const {dx,dy}=scaleGestureDelta(delta,doc.viewport.zoom);
        if(lasso){path.push(origin.x+dx,origin.y+dy);lassoPath=[...path];return}
        marquee={x:origin.x,y:origin.y,w:dx,h:dy};
      },
      onEnd:(_delta,moved)=>{
        const rect=marquee;marquee=null;lassoPath=null;
        if(!moved)return;
        const hits=lasso?nodesInLasso(doc.nodes,path):rect?nodesInMarquee(doc.nodes,rect):[];
        organizationNotice='';
        contextSelection=additive?[...new Set([...beforeSelection,...hits])]:hits;
        selected=contextSelection.at(-1)??null;
      },
      onCancel:()=>{marquee=null;lassoPath=null}
    });
  }
  function select(node:WorkspaceNode,additive=false){organizationNotice='';selectedLinkId=null;if(additive){const removing=contextSelection.includes(node.id);contextSelection=removing?contextSelection.filter(id=>id!==node.id):[...contextSelection,node.id];selected=removing?contextSelection.at(-1)||null:node.id}else{selected=node.id;contextSelection=[node.id]}if(node.z<doc.nextZ)doc={...doc,nextZ:doc.nextZ+1,nodes:doc.nodes.map(candidate=>candidate.id===node.id?{...candidate,z:doc.nextZ+1}:candidate)}}
  // --- Transient gesture layer -------------------------------------------------
  // Drag/resize/pan write geometry straight to the DOM for the duration of the
  // gesture and commit to `doc` exactly once, on release. Mutating `doc` per
  // pointermove used to re-run every whole-array derivation (connections, search,
  // scenes, viewport count) on every frame of every drag.
  let snapGuides:SnapGuide[]=[];
  function nodeElement(id:string){return worldLayer?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)??null}
  type DragTargets=Array<{id:string;element:HTMLElement|null;x:number;y:number}>;
  function restoreDragTargets(targets:DragTargets){for(const target of targets){if(target.element)target.element.style.transform=`translate(${target.x}px,${target.y}px)`}}
  function drag(event:PointerEvent,node:WorkspaceNode){
    if((event.target as HTMLElement).closest('button,input,textarea,iframe,a,.scroll,.xterm'))return;
    event.preventDefault();
    if(event.shiftKey){select(node,true);return}
    const before=doc;
    select(node);
    // A frame carries its members, so they all need transient transforms too.
    const moving=node.type==='frame'?[node,...doc.nodes.filter(candidate=>candidate.frameId===node.id)]:[node];
    const targets:DragTargets=moving.map(target=>({id:target.id,element:nodeElement(target.id),x:target.x,y:target.y}));
    const origin={x:node.x,y:node.y};
    const movingIds=new Set(targets.map(target=>target.id));
    const snapNeighbours=doc.nodes.filter(candidate=>!movingIds.has(candidate.id)&&candidate.type!=='frame');
    // Snap the dragged node, then shift the whole group by the same correction so
    // a frame and its members stay rigid.
    const settle=(delta:{dx:number;dy:number})=>{
      const{dx,dy}=scaleGestureDelta(delta,doc.viewport.zoom);
      const snapped=snapWorkspaceRect({x:origin.x+dx,y:origin.y+dy,w:node.w,h:node.h},snapNeighbours,doc.viewport.zoom);
      return{dx:dx+(snapped.x-(origin.x+dx)),dy:dy+(snapped.y-(origin.y+dy)),guides:snapped.guides};
    };
    trackPointerGesture(event,{
      onMove:(delta)=>{
        const settled=settle(delta);
        snapGuides=settled.guides;
        for(const target of targets){if(target.element)target.element.style.transform=`translate(${target.x+settled.dx}px,${target.y+settled.dy}px)`}
      },
      onEnd:(delta,moved)=>{
        snapGuides=[];
        if(!moved){restoreDragTargets(targets);return}
        const settled=settle(delta);
        doc=moveNodeAndFrameContents(doc,node.id,origin.x+settled.dx,origin.y+settled.dy);
        remember(before);persist();
      },
      onCancel:()=>{snapGuides=[];restoreDragTargets(targets)}
    });
  }
  function resize(event:PointerEvent,node:WorkspaceNode){
    event.preventDefault();event.stopPropagation();
    const before=doc;
    const element=nodeElement(node.id);
    const origin={w:node.w,h:node.h};
    const nextSize=(delta:{dx:number;dy:number})=>({w:Math.max(140,origin.w+delta.dx),h:Math.max(80,origin.h+delta.dy)});
    const restore=()=>{if(element){element.style.width=`${origin.w}px`;element.style.height=`${origin.h}px`}};
    trackPointerGesture(event,{
      onMove:(delta)=>{
        if(!element)return;
        const size=nextSize(scaleGestureDelta(delta,doc.viewport.zoom));
        element.style.width=`${size.w}px`;element.style.height=`${size.h}px`;
      },
      onEnd:(delta,moved)=>{
        if(!moved){restore();return}
        const size=nextSize(scaleGestureDelta(delta,doc.viewport.zoom));
        doc={...doc,nodes:doc.nodes.map(candidate=>candidate.id===node.id?{...candidate,...size}:candidate)};
        if(node.type==='frame')doc=assignNodesToFrame(doc,node.id);
        remember(before);persist();
      },
      onCancel:restore
    });
  }
  function worldTransform(viewport:{x:number;y:number;zoom:number}){return `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`}
  function pan(event:PointerEvent){
    if(event.target!==canvas)return;
    // Plain drag on empty canvas still pans, which is the gesture this canvas has
    // always had. Holding a modifier turns the same drag into a marquee, and the
    // pen tool turns it into a stroke.
    if(penActive&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey){draw(event);return}
    if(event.metaKey||event.ctrlKey||event.shiftKey){startMarquee(event);return}
    const origin={...doc.viewport};
    trackPointerGesture(event,{
      onMove:(delta)=>{if(worldLayer)worldLayer.style.transform=worldTransform({...origin,x:origin.x+delta.dx,y:origin.y+delta.dy})},
      onEnd:(delta,moved)=>{
        if(!moved){if(worldLayer)worldLayer.style.transform=worldTransform(doc.viewport);return}
        doc={...doc,viewport:{...doc.viewport,x:origin.x+delta.dx,y:origin.y+delta.dy}};
        persist();
      },
      onCancel:()=>{if(worldLayer)worldLayer.style.transform=worldTransform(doc.viewport)}
    });
  }
  // Panes that own a scroller mark themselves with `data-scrollable`. The previous
  // implementation walked every ancestor calling getComputedStyle, forcing a style
  // recalc on the hottest input path in the app.
  function canNestedSurfaceScroll(event:WheelEvent){
    const element=event.target instanceof HTMLElement?event.target.closest<HTMLElement>('[data-scrollable],.scroll,.xterm-viewport,textarea'):null;
    if(!element||!canvas?.contains(element))return false;
    const canY=element.scrollHeight>element.clientHeight&&((event.deltaY<0&&element.scrollTop>0)||(event.deltaY>0&&element.scrollTop+element.clientHeight<element.scrollHeight-1));
    const canX=element.scrollWidth>element.clientWidth&&((event.deltaX<0&&element.scrollLeft>0)||(event.deltaX>0&&element.scrollLeft+element.clientWidth<element.scrollWidth-1));
    return canX||canY;
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
  function changeHistory(direction:'undo'|'redo'){flushPatches();const result=direction==='undo'?undoWorkspace(workspaceHistory,doc):redoWorkspace(workspaceHistory,doc);if(!result)return;doc=result.doc;workspaceHistory=result.history;selected=null;contextSelection=[];currentSceneId=null;organizationNotice='';persist();}
  const ARROW_NUDGE:Record<string,[number,number]>={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]};
  function keydown(event:KeyboardEvent){const editable=(event.target as Element)?.closest?.('input,textarea,[contenteditable]');const command=event.metaKey||event.ctrlKey;if(!editable&&command&&event.key.toLowerCase()==='z'){event.preventDefault();changeHistory(event.shiftKey?'redo':'undo');return}if(!editable&&command&&event.key.toLowerCase()==='y'){event.preventDefault();changeHistory('redo');return}if(!editable&&event.shiftKey&&event.key==='1'){event.preventDefault();fitAll();return}
    if(!editable&&!command){
      if(event.key.toLowerCase()==='p'&&!event.altKey&&!event.repeat){event.preventDefault();togglePen();return}
      if(['Delete','Backspace'].includes(event.key)&&selectedLinkId){event.preventDefault();deleteLink(selectedLinkId);return}
      if(['Delete','Backspace'].includes(event.key)&&activeSelection.length){event.preventDefault();deleteSelection();return}
      const nudge=ARROW_NUDGE[event.key];
      // Shift takes the step from "adjust" to "reposition", matching every other
      // canvas tool. Held arrows repeat, so this coalesces into one history entry
      // only in the sense that each repeat is its own — acceptable for 1px steps.
      if(nudge&&activeSelection.length){event.preventDefault();const step=event.shiftKey?10:1;nudgeSelection(nudge[0]*step,nudge[1]*step);return}
    }
    if(!editable&&command){
      const key=event.key.toLowerCase();
      if(key==='a'){event.preventDefault();selectAll();return}
      if(key==='d'){event.preventDefault();duplicateSelection();return}
      if(key==='c'&&activeSelection.length){event.preventDefault();void copySelection();return}
      if(key==='x'&&activeSelection.length){event.preventDefault();void copySelection(true);return}
    }if(event.altKey&&event.code==='Space'&&!event.repeat){event.preventDefault();void summonComposer();return}if(command&&event.key.toLowerCase()==='k'){event.preventDefault();if(omnibar)omnibar=false;else void openCommands();}if(event.key==='Escape'){omnibar=false;composerOpen=false;selectedLinkId=null;}}
  async function drop(event:DragEvent){event.preventDefault();if(!event.dataTransfer)return;const at={x:(event.clientX-doc.viewport.x)/doc.viewport.zoom,y:(event.clientY-doc.viewport.y)/doc.viewport.zoom};addSeeds(await seedsFromDataTransfer(event.dataTransfer),at)}
  async function addFiles(files:File[]){const seeds=await seedsFromFiles(files);const center={x:(-doc.viewport.x+innerWidth/2)/doc.viewport.zoom,y:(-doc.viewport.y+innerHeight/2)/doc.viewport.zoom};addSeeds(seeds,{x:center.x-190,y:center.y-150})}
  onMount(()=>{let disposed=false;const nativeStops:Array<()=>void>=[];load();refreshContext();refreshBoard();refreshDaemon();const daemonTimer=setInterval(()=>void refreshDaemon(),10000);const move=(e:PointerEvent)=>{pointer.x=e.clientX;pointer.y=e.clientY};const paste=(e:ClipboardEvent)=>{if((e.target as Element)?.closest?.('input,textarea,[contenteditable]'))return;const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();void addFiles(files);return}const text=e.clipboardData?.getData('text/plain');if(!text)return;const at=workspacePoint(pointer.x,pointer.y);const copied=readWorkspaceClipboard(text);if(copied){e.preventDefault();pasteNodes(copied,at);return}addSeeds([seedFromString(text)],at)};const nativeSummon=()=>void summonComposer();const summonFromUrl=new URLSearchParams(location.search).get('summon')==='1';if(summonFromUrl){history.replaceState(history.state,'',location.pathname);void summonComposer()}void import('@tauri-apps/api/core').then(async(core)=>{if(!core.isTauri())return;const{listen}=await import('@tauri-apps/api/event');const listeners=await Promise.all([listen('hii://summon',nativeSummon),listen('hii://command-palette',()=>void openCommands()),listen('hii://open-browser',()=>spawn('browser')),listen('hii://fit-all',fitAll),listen('hii://space-refresh',()=>window.dispatchEvent(new CustomEvent('hii:space-refresh'))),listen('hii://develop-hii',openDevelopmentSession)]);if(disposed)listeners.forEach(stop=>stop());else nativeStops.push(...listeners)}).catch(()=>{});window.addEventListener('hii:summon',nativeSummon);window.addEventListener('keydown',keydown);window.addEventListener('pointermove',move);window.addEventListener('paste',paste);return()=>{disposed=true;flushPatches();clearInterval(daemonTimer);nativeStops.forEach(stop=>stop());window.removeEventListener('hii:summon',nativeSummon);window.removeEventListener('keydown',keydown);window.removeEventListener('pointermove',move);window.removeEventListener('paste',paste)}});
</script>

{#if !data.enabled}<div class="hii-page flex min-h-[60vh] flex-col items-center justify-center gap-3"><p class="hii-kicker">surface off</p><h1 class="hii-page-title">HII is turned off</h1></div>
{:else}<main bind:this={canvas} bind:clientWidth={canvasWidth} bind:clientHeight={canvasHeight} class="absolute inset-0 touch-none overflow-hidden" class:cursor-crosshair={penActive} on:pointerdown={pan} on:dblclick={openExplorer} on:wheel={trackpad} on:dragover|preventDefault on:drop={drop} style="background:#fff radial-gradient(circle,rgba(23,23,23,.08) 1px,transparent 1px);background-size:32px 32px">
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
  {#if organizationNotice&&!contextSelection.length}
    <section data-workspace-ui role="status" aria-live="polite" class="absolute left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-emerald-900/10 bg-white/95 p-1.5 pl-4 shadow-xl backdrop-blur-xl">
      <span class="font-mono text-[9px] uppercase tracking-[.08em] text-emerald-800">{organizationNotice}</span>
      <button class="rounded-full bg-neutral-950 px-4 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-white" on:click={()=>changeHistory('undo')}>Undo <kbd class="ml-1 text-white/50">⌘Z</kbd></button>
      <button class="rounded-full px-2 py-2 font-mono text-[9px] uppercase text-neutral-400 hover:text-neutral-900" aria-label="Dismiss organization notice" on:click={()=>organizationNotice=''}>×</button>
    </section>
  {/if}
  {#if contextSelection.length&&!composerOpen}
    <section data-workspace-ui role="status" class="absolute left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-blue-900/10 bg-white/95 p-1.5 pl-4 shadow-xl backdrop-blur-xl">
      <span class="font-mono text-[9px] uppercase tracking-[.1em] text-blue-700">{contextSelection.length} context object{contextSelection.length===1?'':'s'} selected</span>
      {#if organizableSelection.length>1}<button class="rounded-full border border-blue-200 bg-blue-50 px-4 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-blue-700 hover:border-blue-400" aria-label="Organize selection into scene" on:click={organizeSelection}>Make Scene</button>{/if}
      <button class="rounded-full border border-neutral-200 px-3 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-neutral-600 hover:border-neutral-400" aria-label="Duplicate selection" on:click={duplicateSelection}>Duplicate <kbd class="ml-1 text-neutral-400">⌘D</kbd></button>
      <button class="rounded-full border border-red-200 px-3 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-red-700 hover:border-red-400" aria-label="Delete selection" on:click={deleteSelection}>Delete <kbd class="ml-1 text-red-300">⌫</kbd></button>
      <button class="rounded-full bg-[var(--hii-electric-blue)] px-4 py-2 font-mono text-[9px] uppercase tracking-[.08em] text-white" on:click={()=>void summonComposer()}>Give intent <kbd class="ml-1 text-white/60">⌥Space</kbd></button>
      <button class="rounded-full px-2 py-2 font-mono text-[9px] uppercase text-neutral-400 hover:text-neutral-900" aria-label="Clear context selection" on:click={()=>{contextSelection=[];selected=null}}>×</button>
    </section>
  {/if}
  <div bind:this={worldLayer} class="absolute left-0 top-0 origin-top-left will-change-transform" style={`transform:${worldTransform(doc.viewport)}`}>
    <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
      <defs>
        <marker id="hii-link-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="strokeWidth" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#171717" />
        </marker>
      </defs>
      {#each authoredLinks as link (link.id)}
        <line x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2}
          stroke={selectedLinkId===link.id?'#176bff':'#171717'}
          stroke-width={selectedLinkId===link.id?2.5:1.75}
          marker-end={link.arrow==='none'?undefined:'url(#hii-link-arrow)'}
          marker-start={link.arrow==='both'?'url(#hii-link-arrow)':undefined}
          vector-effect="non-scaling-stroke" />
        <!-- A wide transparent line makes a 2px connector clickable at any zoom. -->
        <line class="pointer-events-auto cursor-pointer" role="button" tabindex="0"
          aria-label="Connector — select to delete" x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2}
          stroke="transparent" stroke-width="14" vector-effect="non-scaling-stroke"
          on:pointerdown|stopPropagation={()=>{selectedLinkId=link.id;selected=null;contextSelection=[]}}
          on:keydown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectedLinkId=link.id}}} />
      {/each}
      {#if lassoPath}
        <polygon points={lassoPath.join(',')} fill="rgba(23,107,255,.08)" stroke="#176bff" stroke-width="1.5"
          stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />
      {/if}
      {#if livePreview}
        <polyline points={livePreview.join(',')} fill="none"
          stroke={INK_DEFAULT_COLOR} stroke-width={INK_DEFAULT_WIDTH} stroke-linecap="round" stroke-linejoin="round" />
      {/if}
      {#if linkDraft}
        <line x1={linkDraft.x1} y1={linkDraft.y1} x2={linkDraft.x2} y2={linkDraft.y2}
          stroke="#176bff" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#hii-link-arrow)" vector-effect="non-scaling-stroke" />
      {/if}
      {#each connections as connection (connection.id)}
        <line x1={connection.x1} y1={connection.y1} x2={connection.x2} y2={connection.y2}
          stroke={connection.kind==='context'?'#8aa4c8':'#176bff'}
          stroke-width={connection.kind==='context'?1.5:2.5}
          stroke-dasharray={connection.kind==='context'?'6 7':'0'}
          opacity={connection.kind==='context'?0.55:0.72}
          vector-effect="non-scaling-stroke" />
      {/each}
      {#each snapGuides as guide, index (index)}
        <line
          x1={guide.axis==='x'?guide.position:guide.from} y1={guide.axis==='x'?guide.from:guide.position}
          x2={guide.axis==='x'?guide.position:guide.to} y2={guide.axis==='x'?guide.to:guide.position}
          stroke="#ff3d7f" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" />
      {/each}
    </svg>
    {#if marquee}
      <div aria-hidden="true" class="pointer-events-none absolute border border-blue-500 bg-blue-500/10"
        style={`left:${Math.min(marquee.x,marquee.x+marquee.w)}px;top:${Math.min(marquee.y,marquee.y+marquee.h)}px;width:${Math.abs(marquee.w)}px;height:${Math.abs(marquee.h)}px`}></div>
    {/if}
    {#each doc.nodes as node (node.id)}{#if !(node.frameId&&collapsedFrameIds.has(node.frameId))}<section role="group" aria-label={`${node.type} workspace node`} data-node-id={node.id} data-context-selected={contextSelection.includes(node.id)} class="group absolute left-0 top-0 flex flex-col overflow-hidden [contain:layout_paint]" class:pointer-events-none={node.type==='frame'} class:ring-2={contextSelection.includes(node.id)||selected===node.id||linkTargetId===node.id} class:ring-blue-500={contextSelection.includes(node.id)||selected===node.id} class:ring-emerald-500={linkTargetId===node.id&&!contextSelection.includes(node.id)&&selected!==node.id} on:pointerdown={(event)=>drag(event,node)} style={`transform:translate(${node.x}px,${node.y}px);width:${node.w}px;height:${node.h}px;z-index:${Math.round(node.z)}`}>
      <header class="pointer-events-none absolute right-1 top-1 z-20"><span class="sr-only">{String(node.payload.title||node.type)}</span><button class="pointer-events-auto grid h-6 w-6 place-items-center rounded-full bg-neutral-950/80 text-sm text-white opacity-0 shadow-sm transition-opacity hover:bg-neutral-950 group-hover:opacity-100 focus:opacity-100" on:click={()=>close(node.id)} aria-label="close node">×</button></header>
      <div class="relative min-h-0 flex-1">
        {#if !isMounted(node)}<div aria-hidden="true" class="h-full rounded-xl border border-neutral-900/5 bg-neutral-100/70"></div>
        {:else if node.type==='frame'}<div class="h-full rounded-2xl border-2 border-dashed border-blue-500/60 bg-blue-50/10">
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
        {:else if node.type==='ink'}<InkPane {node} />
        {:else if ['note','text','canvas-text','link','file','image','media','html','font'].includes(node.type)}<StaticNode {node} onPayload={(payload)=>patchSoon(node.id,{payload:{...node.payload,...payload}})} onSize={(size)=>patch(node.id,size)} onPromote={(item,label)=>promoteContactSheetItem(node,item,label)} onOrganize={()=>organizeContactSheetSelection(node)} />
        {:else if node.type==='intent'}<IntentPane {node} />
        {:else if node.type==='run'&&node.payload.developmentSession===true}<DevelopmentSessionPane {node} onPatch={(next)=>patchRunNode(node,next)} onFollowUp={(text)=>followUp(node,text)} onComplete={(result)=>completedRunNodes(node,result)} onCapabilityDraft={(result)=>materializeCapabilityDraft(node,result)} />
        {:else if node.type==='run'}<SpatialRunPane {node} onPatch={(next)=>patchRunNode(node,next)} onFollowUp={(text)=>followUp(node,text)} onComplete={(result)=>completedRunNodes(node,result)} onCapabilityDraft={(result)=>materializeCapabilityDraft(node,result)} />
        {:else if node.type==='document'}<DocumentPane {node} onPayload={(payload)=>patchSoon(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='cad'}<CadPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='model'}{#if ModelPaneComponent}<svelte:component this={ModelPaneComponent} {node} onPayload={(payload:Record<string,unknown>)=>patch(node.id,{payload:{...node.payload,...payload}})} />{:else}<div class="grid h-full place-items-center bg-[#f3f1ec] p-5 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-400">{modelPaneError||'loading 3D viewer…'}</div>{/if}
        {:else if node.type==='terminal'}<TerminalPane sessionId={String(node.payload.sessionId)} cwd={String(node.payload.cwd||'')} />
        {:else if node.type==='browser'}<BrowserPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='explorer'}<ExplorerPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='context'}<div class="scroll h-full overflow-auto p-3.5"><div class="flex justify-between font-mono text-[10px] uppercase text-neutral-400"><span>system context</span><button on:click={refreshContext}>refresh</button></div><div class="mt-3 rounded-md border p-3"><strong class="font-mono text-[11px]">{context?.git?.branch||'reading…'}</strong><p class="font-mono text-[10px] text-neutral-500">{context?.git?.status?.length||0} dirty paths</p></div><h3 class="mt-3 font-mono text-[10px] uppercase text-neutral-400">next</h3>{#each context?.nextActions?.slice(0,4)||[] as action}<p class="mt-1 text-[12px]"><span class="text-[var(--hii-electric-blue)]">{action.track}</span> {action.next}</p>{/each}</div>
        {:else if node.type==='board'}
          <div class="scroll h-full overflow-auto p-3.5">
            <div class="flex justify-between font-mono text-[10px] uppercase text-neutral-400">
              <span>governed board</span>
              <a href="/boards">review ↗</a>
            </div>
            {#each ['doing','next','blocked','backlog'] as lane}
              {#if board.some(task=>task.lane===lane)}
                <h3 class="mt-3 font-mono text-[10px] uppercase text-neutral-400">{lane}</h3>
                {#each board.filter(task=>task.lane===lane).slice(0,6) as task}
                  <div class={`mt-1.5 rounded-md border p-2 text-[12px] ${task.reviewState==='proposed'?'border-[var(--hii-electric-blue)]':''}`}>
                    <div class="mb-1 flex justify-between font-mono text-[9px] uppercase text-neutral-400">
                      <span>{task.reviewState==='proposed'?'proposal':task.runStatus||task.priority}</span>
                      <span>{task.origin||'legacy'}</span>
                    </div>
                    <strong class="block font-medium leading-4">{task.title}</strong>
                    {#if task.receiptRef}
                      <span class="mt-1 block truncate font-mono text-[8px] uppercase text-emerald-700">receipt linked</span>
                    {:else if task.runId}
                      <span class="mt-1 block truncate font-mono text-[8px] text-neutral-400">run {String(task.runId).slice(0,12)}</span>
                    {/if}
                    {#if task.reviewState!=='proposed'&&(
                      ['next','doing'].includes(task.lane)
                      || (task.lane==='blocked'&&['failed','cancelled'].includes(String(task.runStatus||'')))
                    )}
                      <button
                        class="mt-2 rounded-full bg-[var(--hii-electric-blue)] px-3 py-1.5 font-mono text-[8px] uppercase tracking-[.06em] text-white disabled:opacity-35"
                        disabled={Boolean(task.runId&&!['failed','cancelled'].includes(String(task.runStatus||'')))}
                        on:click={()=>createBoardRun(task,node)}
                      >
                        {['failed','cancelled'].includes(String(task.runStatus||''))
                          ? 'Prepare fresh retry'
                          : task.runId
                            ? 'Run already prepared'
                            : 'Prepare bounded run'}
                      </button>
                    {/if}
                  </div>
                {/each}
              {/if}
            {/each}
          </div>
        {:else if node.type==='surface'}<SurfacePane path={String(node.payload.path||'/')} title={String(node.payload.title||'HII surface')} />
        {:else if node.type==='chat'}<ChatPane {node} onPayload={(payload)=>patch(node.id,{payload:{...node.payload,...payload}})} />
        {:else if node.type==='sound-field'}<div class="relative h-full overflow-hidden bg-[#07131c] text-white"><div class="absolute inset-0 opacity-70" style="background:radial-gradient(circle at 65% 55%,#ffce3a 0,transparent 7%),radial-gradient(circle at 45% 40%,#ff6b35 0,transparent 14%),radial-gradient(circle at 50% 50%,#176bff 0,transparent 55%)"></div><div class="relative p-5"><p class="font-mono text-xs text-white/60">MODELED / WEEKDAY / 18:00</p><h2 class="mt-2 text-3xl">South Berkeley Sound Field</h2><p class="mt-3 max-w-sm text-sm text-white/70">A provenance-aware spatial scene. Replace modeled values with calibrated measurements before analysis.</p></div></div>
        {:else}<div class="grid h-full place-items-center p-4 font-mono text-[11px] text-neutral-400">{String(node.payload.text||node.payload.title||node.type)}</div>{/if}
      </div><button type="button" aria-label={`Resize ${node.type} node`} class="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize" on:pointerdown={(event)=>resize(event,node)}></button>
      {#if node.type!=='frame'}
        <button type="button" aria-label={`Draw a connector from this ${node.type} node`}
          class="absolute -right-2 top-1/2 z-20 grid h-4 w-4 -translate-y-1/2 place-items-center rounded-full border border-neutral-900/20 bg-white text-[8px] text-neutral-500 opacity-0 shadow transition-opacity hover:bg-[var(--hii-electric-blue)] hover:text-white group-hover:opacity-100 focus:opacity-100"
          on:pointerdown={(event)=>startLink(event,node)}>→</button>
      {/if}
    </section>{/if}{/each}
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
        <SystemSpace />
        <p class="mt-6 text-center font-mono text-[9px] uppercase tracking-[0.1em] text-neutral-400">paste or drop anywhere · ⌘K for every command · your files stay local</p>
      </div>
    </section>
  {/if}
  {#if libraryOpen}
    <ImageLibrary images={libraryImages} onClose={()=>libraryOpen=false} onPlace={placeLibraryImage} />
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
  <div data-workspace-ui class="absolute left-1/2 top-4 z-40 -translate-x-1/2">
    <EcosystemNav current="workspace" />
  </div>
  <div data-workspace-ui class="absolute bottom-5 left-5 z-40 flex gap-2">
    <button
      class={`rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] shadow-lg backdrop-blur ${penActive?'border-transparent bg-neutral-950 text-white':'border-neutral-900/10 bg-white/95 text-neutral-700 hover:border-neutral-900/25'}`}
      aria-pressed={penActive} on:click={togglePen}
    >Pen <kbd class={`ml-2 ${penActive?'text-white/50':'text-neutral-400'}`}>P</kbd></button>
    <button
      class={`rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] shadow-lg backdrop-blur ${libraryOpen?'border-transparent bg-neutral-950 text-white':'border-neutral-900/10 bg-white/95 text-neutral-700 hover:border-neutral-900/25'}`}
      aria-pressed={libraryOpen} on:click={()=>libraryOpen=!libraryOpen}
    >Images</button>
    {#if doc.nodes.length}
    <button class="rounded-full border border-neutral-900/10 bg-white/95 px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-neutral-700 shadow-lg backdrop-blur hover:border-neutral-900/25" on:click={fitAll} aria-label="Fit all workspace content">Fit all <kbd class="ml-2 text-neutral-400">⇧1</kbd></button>
    <div class="relative">
      <button class="rounded-full border border-neutral-900/10 bg-white/95 px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-neutral-700 shadow-lg backdrop-blur hover:border-neutral-900/25" on:click={()=>mapMenu=!mapMenu} aria-label="Open workspace map" aria-expanded={mapMenu}>Map <kbd class="ml-2 text-neutral-400">{scenes.length}</kbd></button>
      {#if mapMenu}<WorkspaceNavigator
        nodes={doc.nodes}
        {currentSceneId}
        onClose={()=>mapMenu=false}
        onCreateScene={()=>{mapMenu=false;spawn('frame')}}
        onOpenScene={openScene}
        onFocusNode={(node)=>{focusNode(node);mapMenu=false}}
        onSelectNodes={selectShownNodes}
        onAdjacentScene={openAdjacentScene}
      />{/if}
    </div>
    {/if}
  </div>
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
  {#if omnibar}<div class="absolute inset-0 z-50 bg-white/80 backdrop-blur-sm"><button type="button" class="absolute inset-0 cursor-default" aria-label="Close command palette" on:click={()=>omnibar=false}></button><div class="absolute left-1/2 top-1/2 w-[min(620px,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl bg-white shadow-2xl" role="dialog" aria-modal="true" aria-label="Create workspace object"><div class="flex items-center gap-3 border-b p-4"><span>⌘K</span><input bind:this={commandInput} bind:value={query} class="w-full outline-none" placeholder="Tell HII what to do, find, open, or create…" on:keydown={(event)=>{if(event.key==='Enter'){event.preventDefault();submitOmnibar()}}} /></div><div class="max-h-[420px] overflow-auto p-2">{#if nodeResults.length}<p class="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[.12em] text-neutral-400">On this canvas</p>{#each nodeResults as result}<button class="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-blue-50" on:click={()=>focusNode(result.node)}><span class="grid h-8 w-8 place-items-center rounded-lg bg-blue-50 text-sm text-blue-600">⌖</span><span class="min-w-0 flex-1"><strong class="block truncate">{result.title}</strong><small class="text-neutral-400">{result.node.type} · focus on canvas</small></span><kbd class="font-mono text-[10px] text-neutral-400">find</kbd></button>{/each}<div class="my-2 border-t"></div>{/if}{#each commands as command}<button class="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-neutral-50" on:click={()=>runCommand(command)}><span class="text-xl">{command[0]==='fit'?'⌖':command[0]==='surface'?'↗':'+'}</span><span class="flex-1"><strong class="block">{command[1]}</strong><small class="text-neutral-400">{command[2]}</small></span><kbd class="font-mono text-[10px] text-neutral-400">{command[0]==='fit'?'view':command[0]==='surface'?'open':command[0]==='upload'?'choose':'create'}</kbd></button>{/each}</div></div></div>{/if}
</main>{/if}
