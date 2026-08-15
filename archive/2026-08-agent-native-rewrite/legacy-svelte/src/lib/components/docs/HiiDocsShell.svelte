<script lang="ts">
  import { page } from '$app/stores';

  export let catalog: Array<{
    slug:string;
    title:string;
    description:string;
    section:string;
    source:string;
    status:string;
  }> = [];
  export let active = '';
  export let title = 'Documentation';
  export let description = '';
  export let source = '';
  export let status = '';
  export let compiledAt = '';
  export let markdown = '';

  type Block =
    | { type:'heading'; level:number; text:string; id:string }
    | { type:'paragraph'|'quote'; text:string }
    | { type:'code'; language:string; text:string }
    | { type:'list'; ordered:boolean; items:string[] }
    | { type:'table'; headers:string[]; rows:string[][] }
    | { type:'rule' };

  const sections=['Start here','Use HII','Build HII','Operate HII','Decisions'];
  let filter='';

  function headingId(value:string,index:number){
    const base=value.toLowerCase().replace(/`/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    return `${base||'section'}-${index}`;
  }

  function cells(line:string){
    return line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim());
  }

  function parseMarkdown(value:string):Block[]{
    const lines=value.replace(/\r/g,'').split('\n'),blocks:Block[]=[];
    let index=0;
    while(index<lines.length){
      const line=lines[index];
      if(!line.trim()){index++;continue}
      const fence=line.match(/^```(.*)$/);
      if(fence){
        const body:string[]=[];index++;
        while(index<lines.length&&!lines[index].startsWith('```'))body.push(lines[index++]);
        index++;
        blocks.push({type:'code',language:fence[1].trim(),text:body.join('\n')});
        continue;
      }
      const heading=line.match(/^(#{1,6})\s+(.+)$/);
      if(heading){
        blocks.push({type:'heading',level:heading[1].length,text:heading[2].trim(),id:headingId(heading[2],blocks.length)});
        index++;continue;
      }
      if(/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())){blocks.push({type:'rule'});index++;continue}
      if(line.startsWith('> ')){
        const quote:string[]=[];
        while(index<lines.length&&lines[index].startsWith('> '))quote.push(lines[index++].slice(2));
        blocks.push({type:'quote',text:quote.join(' ')});
        continue;
      }
      if(line.includes('|')&&index+1<lines.length&&/^\s*\|?[\s:|-]+\|/.test(lines[index+1])){
        const headers=cells(line);index+=2;const rows:string[][]=[];
        while(index<lines.length&&lines[index].includes('|')&&lines[index].trim())rows.push(cells(lines[index++]));
        blocks.push({type:'table',headers,rows});continue;
      }
      const list=line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
      if(list){
        const ordered=/\d+\./.test(list[2]),items:string[]=[];
        while(index<lines.length){
          const item=lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
          if(!item||/\d+\./.test(item[2])!==ordered)break;
          items.push(item[3]);index++;
        }
        blocks.push({type:'list',ordered,items});continue;
      }
      const paragraph=[line.trimStart()];index++;
      while(index<lines.length&&lines[index].trim()&&!/^(#{1,6})\s|^```|^> |^(\s*)([-*+]|\d+\.)\s+/.test(lines[index])){
        if(lines[index].includes('|')&&index+1<lines.length&&/^\s*\|?[\s:|-]+\|/.test(lines[index+1]))break;
        paragraph.push(lines[index].trimStart());index++;
      }
      blocks.push({type:'paragraph',text:paragraph.map((part,partIndex)=>`${part.trim()}${partIndex<paragraph.length-1?(part.endsWith('  ')?'\n':' '):''}`).join('')});
    }
    return blocks;
  }

  function escapeHtml(value:string){
    return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function docHref(value:string){
    if(value.startsWith('http://')||value.startsWith('https://')||value.startsWith('mailto:')||value.startsWith('#')||value.startsWith('/'))return value;
    const normalized=value.split('#')[0].replace(/^\.\//,'');
    const match=catalog.find(doc=>doc.source===normalized||doc.source===`docs/${normalized}`||doc.source.endsWith(`/${normalized}`));
    return match?`/docs/${match.slug}`:'#';
  }

  function inline(value:string){
    let html=escapeHtml(value);
    html=html.replace(/`([^`]+)`/g,'<code>$1</code>');
    html=html.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    html=html.replace(/\*([^*]+)\*/g,'<em>$1</em>');
    html=html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\\s+&quot;[^&]*&quot;)?\)/g,(_match,label,href)=>`<a href="${escapeHtml(docHref(href))}">${label}</a>`);
    html=html.replace(/\n/g,'<br />');
    return html;
  }

  $: blocks=parseMarkdown(markdown);
  $: visibleCatalog=catalog.filter(doc=>`${doc.title} ${doc.description} ${doc.section}`.toLowerCase().includes(filter.toLowerCase()));
  $: headings=blocks.filter((block):block is Extract<Block,{type:'heading'}>=>block.type==='heading'&&block.level===2);
</script>

<svelte:head><title>{title} · HII documentation</title><meta name="description" content={description||'HII product and developer documentation'} /></svelte:head>

<div class="docs-shell">
  <aside class="docs-nav">
    <a class="docs-brand" href="/docs"><span>hii</span><small>field manual</small></a>
    <label class="docs-search"><span class="sr-only">Search documentation</span><input bind:value={filter} placeholder="Find a document…" /></label>
    <details class="docs-mobile-nav">
      <summary>Browse documents <span>↓</span></summary>
      {#each sections as section}
        {#if visibleCatalog.some(doc=>doc.section===section)}
          <p>{section}</p>
          {#each visibleCatalog.filter(doc=>doc.section===section) as doc}
            <a href={`/docs/${doc.slug}`} aria-current={doc.slug===active?'page':undefined}>{doc.title}</a>
          {/each}
        {/if}
      {/each}
    </details>
    <nav aria-label="Documentation">
      {#each sections as section}
        {#if visibleCatalog.some(doc=>doc.section===section)}
          <p>{section}</p>
          {#each visibleCatalog.filter(doc=>doc.section===section) as doc}
            <a href={`/docs/${doc.slug}`} aria-current={doc.slug===active?'page':undefined}>
              <span>{doc.title}</span><i data-status={doc.status}></i>
            </a>
          {/each}
        {/if}
      {/each}
    </nav>
    <footer><a href="/">← workspace</a><a href="/landing">website ↗</a></footer>
  </aside>

  <main class="docs-main">
    <header class="docs-header">
      <div><p>Human Information Interface / Documentation</p><h1>{title}</h1><span>{description}</span></div>
      {#if source}<dl><div><dt>Source</dt><dd>{source}</dd></div><div><dt>Status</dt><dd>{status}</dd></div>{#if compiledAt}<div><dt>Compiled</dt><dd>{new Date(`${compiledAt}T12:00:00`).toLocaleDateString()}</dd></div>{/if}</dl>{/if}
    </header>

    {#if markdown}
      <div class="docs-reading-grid">
        <article class="docs-article">
          {#each blocks as block}
            {#if block.type==='heading'}
              <svelte:element this={`h${block.level}`} id={block.id}>{block.text}</svelte:element>
            {:else if block.type==='paragraph'}<p>{@html inline(block.text)}</p>
            {:else if block.type==='quote'}<blockquote>{@html inline(block.text)}</blockquote>
            {:else if block.type==='code'}<div class="docs-code"><span>{block.language||'text'}</span><pre><code>{block.text}</code></pre></div>
            {:else if block.type==='list'}
              {#if block.ordered}<ol>{#each block.items as item}<li>{@html inline(item)}</li>{/each}</ol>
              {:else}<ul>{#each block.items as item}<li>{@html inline(item)}</li>{/each}</ul>{/if}
            {:else if block.type==='table'}<div class="docs-table-wrap"><table><thead><tr>{#each block.headers as cell}<th>{@html inline(cell)}</th>{/each}</tr></thead><tbody>{#each block.rows as row}<tr>{#each row as cell}<td>{@html inline(cell)}</td>{/each}</tr>{/each}</tbody></table></div>
            {:else}<hr />{/if}
          {/each}
        </article>
        {#if headings.length}
          <aside class="docs-toc"><p>On this page</p>{#each headings as heading}<a href={`#${heading.id}`}>{heading.text}</a>{/each}</aside>
        {/if}
      </div>
    {:else}
      <section class="docs-index">
        <p class="docs-thesis">One source-linked manual for understanding, using, building, and operating HII.</p>
        {#each sections as section,index}
          <section><header><span>{String(index+1).padStart(2,'0')}</span><h2>{section}</h2></header>
            <div>{#each catalog.filter(doc=>doc.section===section) as doc}<a href={`/docs/${doc.slug}`}><span><strong>{doc.title}</strong><small>{doc.description}</small></span><b>→</b></a>{/each}</div>
          </section>
        {/each}
      </section>
    {/if}
  </main>
</div>

<style>
  .docs-shell{min-height:calc(100vh - 66px);background:#fbfbf8;color:#171717;display:grid;grid-template-columns:280px minmax(0,1fr)}
  .docs-nav{position:sticky;top:0;height:calc(100vh - 66px);overflow:auto;border-right:1px solid #dfe3e8;background:#f2f4f5;padding:26px 20px;display:flex;flex-direction:column}
  .docs-brand{display:flex;align-items:baseline;gap:10px;color:inherit;text-decoration:none}.docs-brand span{font-size:30px;font-weight:800;letter-spacing:-.08em}.docs-brand small{font:700 9px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.14em;color:#65707b}
  .docs-search{margin:25px 0 20px}.docs-search input{width:100%;border:1px solid #d7dce1;border-radius:10px;background:white;padding:10px 12px;font-size:12px;outline:none}.docs-search input:focus{border-color:#176bff;box-shadow:0 0 0 3px rgba(23,107,255,.1)}
  .docs-nav nav p{margin:20px 10px 6px;font:700 9px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:#8a949e}
  .docs-nav nav a{display:flex;align-items:center;justify-content:space-between;gap:10px;border-radius:9px;padding:8px 10px;color:#46515c;text-decoration:none;font-size:12px}.docs-nav nav a:hover{background:#e7eaed;color:#171717}.docs-nav nav a[aria-current=page]{background:#171717;color:white}.docs-nav nav i{width:6px;height:6px;border-radius:50%;background:#a9b0b7}.docs-nav nav i[data-status=canonical]{background:#176bff}.docs-nav nav i[data-status=current]{background:#35d07f}.docs-nav nav i[data-status=release-gated]{background:#ffb545}
  .docs-nav footer{display:flex;justify-content:space-between;margin-top:auto;padding-top:28px}.docs-nav footer a{font:700 9px/1 ui-monospace,monospace;text-transform:uppercase;color:#65707b;text-decoration:none}
  .docs-mobile-nav{display:none}
  .docs-main{min-width:0;padding:54px clamp(28px,6vw,92px) 100px}
  .docs-header{display:flex;justify-content:space-between;gap:36px;border-bottom:1px solid #cfd5da;padding-bottom:36px}.docs-header>div{max-width:760px}.docs-header p{margin:0 0 20px;font:700 9px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.14em;color:#176bff}.docs-header h1{margin:0;font-size:clamp(42px,6vw,82px);line-height:.93;letter-spacing:-.065em}.docs-header>div>span{display:block;max-width:650px;margin-top:22px;color:#65707b;font-size:16px;line-height:1.6}.docs-header dl{min-width:210px;margin:0;border-left:1px solid #dfe3e8;padding-left:20px}.docs-header dl div+div{margin-top:16px}.docs-header dt{font:700 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:#9aa2aa}.docs-header dd{margin:5px 0 0;font:500 10px/1.45 ui-monospace,monospace;word-break:break-word}
  .docs-reading-grid{display:grid;grid-template-columns:minmax(0,760px) 180px;gap:70px;justify-content:center}.docs-article{padding-top:58px;min-width:0}.docs-article :global(h1){display:none}.docs-article :global(h2){scroll-margin-top:24px;margin:70px 0 22px;font-size:34px;line-height:1.05;letter-spacing:-.04em}.docs-article :global(h2:first-child){margin-top:0}.docs-article :global(h3){scroll-margin-top:24px;margin:42px 0 14px;font-size:21px;letter-spacing:-.025em}.docs-article :global(h4),.docs-article :global(h5),.docs-article :global(h6){margin:28px 0 10px}.docs-article>p{margin:0 0 20px;font-size:15px;line-height:1.75;color:#414a52}.docs-article :global(a){color:#176bff;text-decoration-thickness:1px;text-underline-offset:3px}.docs-article :global(code){border-radius:5px;background:#edf0f2;padding:2px 5px;font:500 .86em/1.5 ui-monospace,monospace}.docs-article blockquote{margin:30px 0;border-left:3px solid #176bff;padding:4px 0 4px 22px;font-size:19px;line-height:1.55;color:#26313a}.docs-article ul,.docs-article ol{margin:0 0 24px;padding-left:24px;color:#414a52}.docs-article li{margin:8px 0;line-height:1.65}.docs-article hr{border:0;border-top:1px solid #dfe3e8;margin:48px 0}
  .docs-code{position:relative;margin:28px 0;overflow:hidden;border-radius:14px;background:#111820;color:#e9f0f4;box-shadow:0 18px 40px rgba(12,21,30,.12)}.docs-code>span{display:block;border-bottom:1px solid #27323d;padding:10px 16px;font:700 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:#7f91a1}.docs-code pre{margin:0;overflow:auto;padding:20px;font:500 12px/1.7 ui-monospace,monospace}.docs-code code{background:none;padding:0}
  .docs-table-wrap{margin:28px 0;overflow:auto;border:1px solid #dfe3e8;border-radius:12px}.docs-table-wrap table{width:100%;border-collapse:collapse;font-size:12px}.docs-table-wrap th{background:#edf0f2;text-align:left}.docs-table-wrap th,.docs-table-wrap td{border-bottom:1px solid #dfe3e8;padding:11px 13px;vertical-align:top}.docs-table-wrap tr:last-child td{border-bottom:0}
  .docs-toc{position:sticky;top:34px;align-self:start;margin-top:58px;border-left:1px solid #dfe3e8;padding-left:18px}.docs-toc p{font:700 9px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:#8a949e}.docs-toc a{display:block;margin-top:10px;color:#65707b;text-decoration:none;font-size:11px;line-height:1.35}.docs-toc a:hover{color:#176bff}
  .docs-index{max-width:980px;margin:0 auto;padding-top:60px}.docs-thesis{max-width:740px;margin:0 0 70px;font-size:clamp(28px,4vw,48px);line-height:1.08;letter-spacing:-.045em}.docs-index>section{display:grid;grid-template-columns:200px 1fr;border-top:1px solid #cfd5da;padding:28px 0}.docs-index header{display:flex;gap:16px}.docs-index header span{font:700 10px/1 ui-monospace,monospace;color:#176bff}.docs-index h2{margin:0;font-size:18px}.docs-index section>div a{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #e3e6e8;padding:17px 4px;color:inherit;text-decoration:none}.docs-index section>div a:first-child{padding-top:0}.docs-index section>div a:hover strong{color:#176bff}.docs-index strong{display:block;font-size:15px}.docs-index small{display:block;margin-top:5px;color:#77818a;line-height:1.4}.docs-index b{color:#176bff}
  @media(max-width:900px){.docs-shell{grid-template-columns:1fr}.docs-nav{position:relative;height:auto;border-right:0;border-bottom:1px solid #dfe3e8}.docs-nav nav{display:none}.docs-mobile-nav{display:block;border:1px solid #d7dce1;border-radius:10px;background:white}.docs-mobile-nav summary{display:flex;cursor:pointer;list-style:none;justify-content:space-between;padding:11px 12px;font:700 10px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.docs-mobile-nav summary::-webkit-details-marker{display:none}.docs-mobile-nav p{margin:16px 12px 5px;font:700 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em;color:#8a949e}.docs-mobile-nav a{display:block;border-top:1px solid #edf0f2;padding:9px 12px;color:#46515c;text-decoration:none;font-size:12px}.docs-mobile-nav a[aria-current=page]{color:#176bff;font-weight:700}.docs-nav footer{margin-top:0}.docs-main{padding-top:36px}.docs-header{display:block}.docs-header dl{margin-top:28px;border-left:0;border-top:1px solid #dfe3e8;padding:20px 0 0}.docs-reading-grid{grid-template-columns:1fr}.docs-toc{display:none}}
  @media(max-width:620px){.docs-main{padding-inline:20px}.docs-header h1{font-size:44px}.docs-index>section{grid-template-columns:1fr;gap:25px}.docs-header{padding-bottom:28px}}
</style>
