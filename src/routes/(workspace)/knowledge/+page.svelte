<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  export let data: PageData;
  type NoteSummary = { id:string; title:string; path:string; folder:string; pinned:boolean; updatedAt:string; excerpt:string; tags:string[]; backlinkCount:number };
  type Note = NoteSummary & { content:string };
  type Detail = { note:Note; tags:string[]; outgoing:Array<any>; backlinks:Array<any>; versions:Array<any>; outline:Array<any> };
  type View = 'write'|'split'|'read'|'graph';

  let workspace = data.workspace;
  let detail: Detail | null = data.note;
  let draft: Note | null = data.note?.note ?? null;
  let view: View = 'split';
  let query = '';
  let results: NoteSummary[] = [];
  let selectedFolder: string | null = null;
  let selectedTag: string | null = null;
  let saveState = 'idle';
  let message = '';
  let paletteOpen = false;
  let paletteQuery = '';
  let graph: any = { nodes: [], edges: [], unresolved: [] };
  let trash: NoteSummary[] = [];
  let showTrash = false;
  let fileInput: HTMLInputElement;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let match = draft?.updatedAt ?? null;

  $: visibleNotes = query.trim() ? results : workspace.notes.filter((note:NoteSummary) => (!selectedFolder || note.folder === selectedFolder) && (!selectedTag || note.tags.includes(selectedTag)));

  const formatTime = (value:string) => new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value));
  const words = (value:string) => value.trim() ? value.trim().split(/\s+/).length : 0;
  const escapeHtml = (value:string) => value.replace(/[&<>"']/g,(c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] ?? c));
  function inline(value:string) {
    return escapeHtml(value)
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,(_m,target,alias) => `<button type="button" class="hii-wikilink" data-wiki="${escapeHtml(target.trim())}">${escapeHtml((alias || target).trim())}</button>`)
      .replace(/`([^`]+)`/g,'<code class="hii-inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  }
  function markdown(value:string) {
    let inCode = false;
    return `<article class="hii-markdown-preview">${value.split('\n').map((line) => {
      if (line.startsWith('```')) { inCode = !inCode; return inCode ? '<pre class="hii-code-block"><code>' : '</code></pre>'; }
      if (inCode) return `${escapeHtml(line)}\n`;
      const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) return `<h${Math.min(heading[1].length+1,6)} class="hii-md-heading hii-md-h${heading[1].length}">${inline(heading[2])}</h${Math.min(heading[1].length+1,6)}>`;
      const task = line.match(/^\s*-\s+\[([ xX])\]\s*(.*)$/); if (task) return `<label class="hii-md-task"><input type="checkbox" ${task[1].toLowerCase()==='x'?'checked':''} disabled> <span>${inline(task[2])}</span></label>`;
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/); if (bullet) return `<div class="hii-md-bullet"><span>—</span><p>${inline(bullet[1])}</p></div>`;
      if (line.startsWith('> ')) return `<blockquote>${inline(line.slice(2))}</blockquote>`;
      if (/^---+$/.test(line.trim())) return '<hr>';
      return line.trim() ? `<p>${inline(line)}</p>` : '<div class="hii-md-space"></div>';
    }).join('')}</article>`;
  }

  async function json(url:string, init?:RequestInit) { const response=await fetch(url,init); const body=await response.json(); if(!response.ok) throw Object.assign(new Error(body.error||'Knowledge action failed.'),{status:response.status}); return body; }
  async function refresh() { workspace=await json('/api/knowledge'); }
  async function openNote(id:string) { detail=await json(`/api/knowledge?mode=note&id=${encodeURIComponent(id)}`); draft=detail?.note ?? null; match=draft?.updatedAt ?? null; saveState='idle'; }
  async function mutate(action:string, body:Record<string,unknown>={}) { return json('/api/knowledge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...body})}); }
  async function createNote(title='Untitled', folder=selectedFolder||'') { try { const value=await mutate('create',{title,folder,content:`# ${title}\n\n`}); await refresh(); await openNote(value.note.id); } catch(error){ message=error instanceof Error?error.message:'Could not create note.'; } }
  async function openDaily(){ const value=await mutate('daily',{date:new Date().toISOString().slice(0,10)}); await refresh(); await openNote(value.note.id); }
  async function save(){ if(!draft)return; saveState='saving'; try { detail=await mutate('save',{id:draft.id,title:draft.title,folder:draft.folder,content:draft.content,pinned:draft.pinned,ifMatch:match}); draft=detail?.note??null; match=draft?.updatedAt??null; saveState='saved'; await refresh(); setTimeout(()=>saveState=saveState==='saved'?'idle':saveState,1200); } catch(error:any){ saveState=error?.status===409?'conflict':'error'; message=error?.message||'Could not save note.'; } }
  function changed(){ saveState='dirty'; if(saveTimer)clearTimeout(saveTimer); saveTimer=setTimeout(save,850); }
  async function follow(title:string){ const found=workspace.notes.find((note:NoteSummary)=>note.title.toLowerCase()===title.toLowerCase()); found?await openNote(found.id):await createNote(title,draft?.folder||''); }
  async function trashCurrent(){ if(!draft)return; await mutate('trash',{id:draft.id}); draft=null; detail=null; await refresh(); }
  async function loadTrash(){ const value=await json('/api/knowledge?mode=trash'); trash=value.notes||[]; showTrash=true; }
  async function restore(id:string){ await mutate('restore',{id}); await refresh(); await loadTrash(); await openNote(id); }
  async function loadGraph(){ graph=await json('/api/knowledge?mode=graph'); view='graph'; }
  async function importFiles(files:FileList|null){ if(!files?.length)return; const payload=await Promise.all(Array.from(files).slice(0,200).map(async file=>({name:file.name,path:(file as any).webkitRelativePath||file.name,content:await file.text()}))); const value=await mutate('import',{files:payload}); await refresh(); if(value.notes?.[0]?.note?.id)await openNote(value.notes[0].note.id); message=`Imported ${value.notes?.length||0} notes.`; }
  function search(){ if(searchTimer)clearTimeout(searchTimer); if(!query.trim()){results=[];return;} searchTimer=setTimeout(async()=>{ const value=await json(`/api/knowledge?mode=search&q=${encodeURIComponent(query)}`); results=value.results||[]; },180); }
  function previewActivate(event:MouseEvent|KeyboardEvent){ if(event instanceof KeyboardEvent && !['Enter',' '].includes(event.key))return; const target=(event.target as HTMLElement).closest<HTMLElement>('[data-wiki]'); if(target?.dataset.wiki) void follow(target.dataset.wiki); }
  function graphActivate(event:KeyboardEvent,id:string){ if(['Enter',' '].includes(event.key)){event.preventDefault();void openNote(id);view='split';} }
  function closePalette(event:MouseEvent|KeyboardEvent){ if(event instanceof KeyboardEvent && event.key!=='Escape')return; if(event instanceof KeyboardEvent || event.target===event.currentTarget)paletteOpen=false; }

  onMount(()=>{ const keys=(event:KeyboardEvent)=>{ if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();paletteOpen=!paletteOpen;} if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='n'){event.preventDefault();void createNote();} if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void save();} }; window.addEventListener('keydown',keys); return()=>window.removeEventListener('keydown',keys); });
</script>

<svelte:head><title>HII / Knowledge</title></svelte:head>
<main class="hii-knowledge-workspace">
  <aside class="hii-knowledge-sidebar">
    <div class="hii-knowledge-search-wrap"><span>⌕</span><input bind:value={query} on:input={search} placeholder="Search your knowledge" aria-label="Search notes" /><kbd>⌘K</kbd></div>
    <div class="hii-knowledge-actions"><button on:click={()=>createNote()}>＋ note</button><button on:click={openDaily}>◫ today</button><button on:click={()=>fileInput.click()}>⇧ import</button><input bind:this={fileInput} type="file" accept=".md,.markdown,.txt" multiple hidden on:change={(event)=>importFiles(event.currentTarget.files)} /></div>
    <div class="hii-knowledge-navscroll">
      <section class="hii-knowledge-navsection"><h2>Folders <span>{workspace.folders.length}</span></h2><button class:is-active={!selectedFolder} on:click={()=>{selectedFolder=null;selectedTag=null}}>⌂ All notes <b>{workspace.notes.length}</b></button>{#each workspace.folders as folder}<button class:is-active={selectedFolder===folder.folder} on:click={()=>{selectedFolder=folder.folder;selectedTag=null}}>⌙ {folder.folder||'Root'} <b>{folder.count}</b></button>{/each}</section>
      <section class="hii-knowledge-navsection"><h2>Tags <span>{workspace.tags.length}</span></h2>{#each workspace.tags.slice(0,24) as tag}<button class:is-active={selectedTag===tag.tag} on:click={()=>{selectedTag=tag.tag;selectedFolder=null}}># {tag.tag} <b>{tag.count}</b></button>{/each}</section>
      <section class="hii-knowledge-navsection"><h2>System</h2><button on:click={loadGraph}>⌬ Graph <b>{workspace.stats.links}</b></button><button on:click={loadTrash}>⌫ Trash <b>{workspace.trashCount}</b></button></section>
    </div>
    <div class="hii-knowledge-db"><span><i></i> local database</span><code>~/.hii/hii.db</code></div>
  </aside>
  <section class="hii-knowledge-index"><header><div><span class="hii-knowledge-eyebrow">{query?'Search':selectedTag?`#${selectedTag}`:selectedFolder||'All notes'}</span><h1>{visibleNotes.length} {visibleNotes.length===1?'note':'notes'}</h1></div><button on:click={()=>paletteOpen=true} aria-label="Open command palette">⌘</button></header><div class="hii-knowledge-note-list">{#each visibleNotes as note}<button class:is-active={draft?.id===note.id} on:click={()=>openNote(note.id)}><span class="hii-note-title">{note.pinned?'◆':''}{note.title}</span><span class="hii-note-path">{note.path}</span><span class="hii-note-excerpt">{note.excerpt||'Empty note'}</span><span class="hii-note-meta"><time>{note.updatedAt?formatTime(note.updatedAt):'match'}</time><span>{note.backlinkCount!==undefined?`${note.backlinkCount}↙`:''}</span></span></button>{/each}{#if visibleNotes.length===0}<div class="hii-knowledge-empty"><strong>Nothing matched.</strong><span>Create a note or try another phrase.</span><button on:click={()=>createNote()}>Create first note</button></div>{/if}</div></section>
  <section class="hii-knowledge-main">
    <div class="hii-knowledge-toolbar"><div class="hii-view-switch" role="group" aria-label="Knowledge view">{#each ['write','split','read','graph'] as mode}<button class:is-active={view===mode} on:click={()=>mode==='graph'?loadGraph():view=mode as View}>{mode}</button>{/each}</div><div class="hii-save-state" data-state={saveState}><i></i> {saveState==='idle'?'local':saveState}</div>{#if draft}<div class="hii-note-tools"><button on:click={()=>{if(draft){draft.pinned=!draft.pinned;changed()}}}>{draft.pinned?'◆ pinned':'◇ pin'}</button><a href={`/api/knowledge?mode=export-note&id=${draft.id}`}>↓ .md</a><button on:click={trashCurrent}>⌫</button></div>{/if}</div>
    {#if view==='graph'}<div class="hii-knowledge-graph-page"><div class="hii-graph-heading"><span>Knowledge constellation</span><small>{graph.nodes.length} notes / {graph.edges.length} resolved links</small></div><div class="hii-graph-wrap"><svg viewBox="0 0 900 620" role="img" aria-label="Knowledge graph">{#each graph.edges as edge,index}<line x1={100+(index%7)*110} y1={140+(index%3)*130} x2={180+((index+2)%7)*100} y2={180+((index+1)%3)*130}></line>{/each}{#each graph.nodes as node,index}<g class="hii-graph-node" class:is-selected={node.id===draft?.id} role="button" tabindex="0" on:click={()=>{openNote(node.id);view='split'}} on:keydown={(event)=>graphActivate(event,node.id)}><circle cx={100+(index%7)*110} cy={120+Math.floor(index/7)*180} r={Math.min(11+Number(node.degree)*1.6,24)}></circle><text x={100+(index%7)*110} y={150+Math.floor(index/7)*180} text-anchor="middle">{node.title.slice(0,24)}</text></g>{/each}</svg></div></div>
    {:else if draft}<div class={`hii-editor-grid is-${view}`}>{#if view!=='read'}<div class="hii-editor-pane"><div class="hii-note-properties"><input class="hii-note-title-input" bind:value={draft.title} on:input={changed} aria-label="Note title" /><div class="hii-note-property-row"><span>folder</span><input bind:value={draft.folder} on:input={changed} placeholder="Root" /><span>{words(draft.content)} words</span></div></div><textarea class="hii-markdown-editor" bind:value={draft.content} on:input={changed} spellcheck="true" aria-label="Markdown editor"></textarea></div>{/if}{#if view!=='write'}<!-- svelte-ignore a11y_no_noninteractive_element_interactions --><div class="hii-preview-pane" role="region" aria-label="Rendered note preview" tabindex="-1" on:click={previewActivate} on:keydown={previewActivate}>{@html markdown(draft.content)}</div>{/if}<aside class="hii-knowledge-context"><section><h2>Outline <span>{detail?.outline.length||0}</span></h2>{#each detail?.outline||[] as item}<button>{item.text}<b>L{item.line}</b></button>{/each}</section><section><h2>Backlinks <span>{detail?.backlinks.length||0}</span></h2>{#each detail?.backlinks||[] as link}<button on:click={()=>openNote(link.sourceNoteId)}>↙ {link.sourceTitle}</button>{/each}</section><section><h2>Outgoing <span>{detail?.outgoing.length||0}</span></h2>{#each detail?.outgoing||[] as link}<button on:click={()=>follow(link.targetTitle)}>↗ {link.targetTitle}</button>{/each}</section><section><h2>Tags <span>{detail?.tags.length||0}</span></h2><div class="hii-context-tags">{#each detail?.tags||[] as tag}<button on:click={()=>{selectedTag=tag;selectedFolder=null}}>#{tag}</button>{/each}</div></section><section><h2>History <span>{detail?.versions.length||0}</span></h2>{#each (detail?.versions||[]).slice(0,8) as version}<button>v{version.version}<b>{formatTime(version.createdAt)}</b></button>{/each}</section></aside></div>
    {:else}<div class="hii-knowledge-welcome"><span class="hii-knowledge-kicker">Human Information Interface</span><h1>Make thought<br />stay useful.</h1><p>Local Markdown, source-linked context, agent receipts, and a graph that grows from real work.</p><div><button on:click={()=>createNote('Start here')}>Create a note</button><button on:click={openDaily}>Open today</button></div></div>{/if}
    {#if message}<div class="hii-knowledge-toast" role="status"><span>{message}</span><button on:click={()=>message=''}>×</button></div>{/if}
  </section>
  {#if showTrash}<div class="hii-knowledge-modal" role="dialog" aria-modal="true" aria-label="Trash" tabindex="-1"><div class="hii-modal-card"><header><h2>Trash</h2><button on:click={()=>showTrash=false}>×</button></header>{#each trash as note}<div class="hii-trash-row"><div><strong>{note.title}</strong><span>{note.path}</span></div><button on:click={()=>restore(note.id)}>Restore</button></div>{/each}</div></div>{/if}
  {#if paletteOpen}<div class="hii-command-overlay" role="dialog" aria-modal="true" aria-label="Knowledge command palette" tabindex="-1" on:click={closePalette} on:keydown={closePalette}><div class="hii-command-palette"><div class="hii-command-input"><span>⌘</span><input bind:value={paletteQuery} placeholder="Type a command or note…" /></div><div class="hii-command-results"><button on:click={()=>{createNote();paletteOpen=false}}><span>New note</span><kbd>⌘ N</kbd></button><button on:click={()=>{openDaily();paletteOpen=false}}><span>Open today</span><kbd>daily</kbd></button><button on:click={()=>{loadGraph();paletteOpen=false}}><span>Show graph</span><kbd>links</kbd></button>{#each workspace.notes.filter((n:NoteSummary)=>n.title.toLowerCase().includes(paletteQuery.toLowerCase())).slice(0,20) as note}<button on:click={()=>{openNote(note.id);paletteOpen=false}}><span>{note.title}</span><kbd>{note.folder||'root'}</kbd></button>{/each}</div></div></div>{/if}
</main>
