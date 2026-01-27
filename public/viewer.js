async function fetchGraph() {
  const res = await fetch('/graph');
  if (!res.ok) throw new Error('Failed to load graph');
  return await res.json();
}

function drawGraph(canvas, graph, highlightId) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth;
  const H = canvas.height = canvas.clientHeight;
  const nodes = graph.nodes.map((n, i) => ({...n, x: Math.random()*W, y: Math.random()*H, vx:0, vy:0}));
  const idIndex = new Map(nodes.map((n,i)=>[n.id,i]));
  const edges = graph.edges.filter(e => idIndex.has(e.source) && idIndex.has(e.target));

  function step() {
    // simple force simulation
    for (const a of nodes) {
      for (const b of nodes) {
        if (a===b) continue;
        const dx=a.x-b.x, dy=a.y-b.y; let d2=dx*dx+dy*dy; if (d2<1) d2=1;
        const f=2000/d2; // repulsion
        a.vx += (dx/Math.sqrt(d2))*f; a.vy += (dy/Math.sqrt(d2))*f;
      }
    }
    for (const e of edges) {
      const a=nodes[idIndex.get(e.source)], b=nodes[idIndex.get(e.target)];
      const dx=b.x-a.x, dy=b.y-a.y; const dist=Math.sqrt(dx*dx+dy*dy)||1; const k=0.01; // spring
      const f=(dist-80)*k; const fx=(dx/dist)*f, fy=(dy/dist)*f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of nodes) {
      n.vx *= 0.85; n.vy *= 0.85; n.x += n.vx; n.y += n.vy;
      n.x = Math.max(10, Math.min(W-10, n.x)); n.y = Math.max(10, Math.min(H-10, n.y));
    }
  }

  function render() {
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle='#ccc'; ctx.lineWidth=1;
    for (const e of edges) {
      const a=nodes[idIndex.get(e.source)], b=nodes[idIndex.get(e.target)];
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    }
    for (const n of nodes) {
      ctx.beginPath();
      const isTag = n.type==='tag';
      ctx.fillStyle = (highlightId && n.id===highlightId) ? '#e91e63' : (isTag ? '#7a2' : '#1976d2');
      ctx.arc(n.x,n.y, isTag?5:6, 0, Math.PI*2);
      ctx.fill();
    }
  }

  let ticks=0; const sim = setInterval(()=>{ step(); render(); if(++ticks>500) clearInterval(sim); }, 16);

  return { nodes, idIndex, edges };
}

async function main() {
  const status = document.getElementById('status');
  const list = document.getElementById('notes');
  const filter = document.getElementById('filter');
  const reload = document.getElementById('reload');
  const canvas = document.getElementById('graph');
  const info = document.getElementById('info');
  const search = document.getElementById('search');
  const searchBtn = document.getElementById('searchBtn');

  async function load() {
    try {
      status.textContent = 'Loading…';
      const graph = await fetchGraph();
      status.textContent = `${graph.nodes.length} nodes, ${graph.edges.length} edges`;
      const view = await drawGraph(canvas, graph);
      // populate list
      const outCounts = new Map();
      const inCounts = new Map();
      for (const e of graph.edges) {
        if (e.kind === 'link') {
          outCounts.set(e.source, (outCounts.get(e.source) || 0) + 1);
          inCounts.set(e.target, (inCounts.get(e.target) || 0) + 1);
        }
      }
      function applyFilter() {
        const q = (filter.value||'').toLowerCase();
        list.innerHTML='';
        graph.nodes.filter(n=>n.type==='note' && n.title.toLowerCase().includes(q))
          .sort((a,b)=> a.title.localeCompare(b.title))
          .forEach(n=>{
            const li=document.createElement('li');
            const oc=outCounts.get(n.id)||0, ic=inCounts.get(n.id)||0;
            li.innerHTML = `${n.title} <span class="note-meta">(→${oc} ←${ic})</span>`;
            li.dataset.id=n.id;
            li.onclick=()=> select(n.id);
            list.appendChild(li);
          });
      }
      function select(id){
        const node = graph.nodes.find(n=>n.id===id); if(!node) return;
        const out=[];
        out.push(`<h3>${node.title}</h3><p><code>${node.id}</code></p>`);
        const outEdges = graph.edges.filter(e=>e.source===id);
        const inEdges = graph.edges.filter(e=>e.target===id);
        if (outEdges.length) out.push('<h4>Links</h4><ul>'+outEdges.map(e=>`<li>${graph.nodes.find(n=>n.id===e.target)?.title||e.target}</li>`).join('')+'</ul>');
        if (inEdges.length) out.push('<h4>Backlinks</h4><ul>'+inEdges.map(e=>`<li>${graph.nodes.find(n=>n.id===e.source)?.title||e.source}</li>`).join('')+'</ul>');
        // fetch preview
        fetch(`/note?id=${encodeURIComponent(id)}`).then(r=>r.json()).then(n=>{
          if (n && n.text) {
            const preview = n.text.split('\n').slice(0, 40).join('\n');
            out.push(`<h4>Preview</h4><pre class="snippet">${preview.replace(/[&<>]/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[s]))}</pre>`);
            out.push(`<div class="actions"><button id="openNote">Open in Editor</button></div>`);
            info.innerHTML=out.join('\n');
            const openBtn = document.getElementById('openNote');
            openBtn.onclick = ()=> fetch(`/open?id=${encodeURIComponent(id)}`).then(()=>{});
          } else {
            info.innerHTML=out.join('\n');
          }
        }).catch(()=>{ info.innerHTML=out.join('\n'); });
        drawGraph(canvas, graph, id); // redraw with highlight
      }
      filter.oninput=applyFilter; applyFilter();
      list.onclick=(ev)=>{
        const li = ev.target.closest('li'); if (!li) return;
        select(li.dataset.id);
      };
    } catch (e) {
      status.textContent = 'Error loading graph';
      console.error(e);
    }
  }

  reload.onclick=load; await load();

  async function runSearch(){
    const q = (search.value||'').trim();
    if (q.length<2) return;
    status.textContent = 'Searching…';
    const res = await fetch('/search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ q }) });
    if (!res.ok) { status.textContent='Search error'; return; }
    const data = await res.json();
    const results = data.results||[];
    const out = [`<h3>Search results (${results.length})</h3>`];
    out.push('<ul>'+results.map(r=>`<li data-id="${r.id}"><strong>${r.title}</strong> <span class="note-meta">(score ${r.score})</span><div class="snippet">${r.snippet.replace(/[&<>]/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[s]))}</div></li>`).join('')+'</ul>');
    info.innerHTML = out.join('\n');
    info.querySelectorAll('li[data-id]').forEach(li=>{
      li.addEventListener('click', ()=>{
        const id = li.getAttribute('data-id');
        // show note via /note
        fetch(`/note?id=${encodeURIComponent(id)}`).then(r=>r.json()).then(n=>{
          const content = `<h3>${n.path}</h3><pre class="snippet">${(n.text||'').replace(/[&<>]/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[s]))}</pre><div class="actions"><button id="openNote">Open in Editor</button></div>`;
          info.innerHTML = content;
          const openBtn = document.getElementById('openNote');
          openBtn.onclick = ()=> fetch(`/open?id=${encodeURIComponent(id)}`).then(()=>{});
        });
      });
    });
    status.textContent = 'Search complete';
  }
  searchBtn.onclick = runSearch;
  search.addEventListener('keydown', (e)=>{ if (e.key==='Enter') runSearch(); });
}

main();
