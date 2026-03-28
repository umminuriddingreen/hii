const PANEL_STORAGE_KEY = 'hii.viewer.panelLayout.v1';

async function fetchGraph() {
  const res = await fetch('/graph', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load graph');
  return await res.json();
}

async function fetchLiveState() {
  const res = await fetch('/live', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load live state');
  return await res.json();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]));
}

function drawGraph(canvas, graph, highlightId) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const W = canvas.width = Math.max(320, Math.floor(rect.width));
  const H = canvas.height = Math.max(240, Math.floor(rect.height));
  const nodes = graph.nodes.map((n) => ({
    ...n,
    x: Math.random() * W,
    y: Math.random() * H,
    vx: 0,
    vy: 0
  }));
  const idIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = graph.edges.filter((e) => idIndex.has(e.source) && idIndex.has(e.target));
  let ticks = 0;
  let sim = null;

  function step() {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const force = 2000 / d2;
        const scale = force / Math.sqrt(d2);
        a.vx += dx * scale;
        a.vy += dy * scale;
      }
    }

    for (const e of edges) {
      const a = nodes[idIndex.get(e.source)];
      const b = nodes[idIndex.get(e.target)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 80) * 0.01;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const n of nodes) {
      n.vx *= 0.85;
      n.vy *= 0.85;
      n.x = Math.max(12, Math.min(W - 12, n.x + n.vx));
      n.y = Math.max(12, Math.min(H - 12, n.y + n.vy));
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(84, 67, 48, 0.18)';
    ctx.lineWidth = 1;
    for (const e of edges) {
      const a = nodes[idIndex.get(e.source)];
      const b = nodes[idIndex.get(e.target)];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const n of nodes) {
      const isTag = n.type === 'tag';
      ctx.beginPath();
      ctx.fillStyle = highlightId && n.id === highlightId
        ? '#b14d2f'
        : isTag
          ? '#56763d'
          : '#285f71';
      ctx.arc(n.x, n.y, isTag ? 5 : 6.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function start() {
    stop();
    sim = setInterval(() => {
      step();
      render();
      ticks += 1;
      if (ticks > 500) stop();
    }, 16);
  }

  function stop() {
    if (sim) clearInterval(sim);
    sim = null;
  }

  render();
  start();

  return { nodes, idIndex, edges, render, stop };
}

function loadPanelLayout() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePanelLayout(layout) {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(layout));
  } catch {}
}

function enablePanels(container) {
  const panels = Array.from(container.querySelectorAll('.panel'));
  const layout = loadPanelLayout();
  const desktopMode = () => window.matchMedia('(min-width: 1101px)').matches;
  let zIndex = 10;

  function clampPanel(panel) {
    if (!desktopMode()) return;
    const mainRect = container.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, mainRect.width - panelRect.width);
    const maxTop = Math.max(0, mainRect.height - panelRect.height);
    const left = Math.max(0, Math.min(parseFloat(panel.style.left || '0'), maxLeft));
    const top = Math.max(0, Math.min(parseFloat(panel.style.top || '0'), maxTop));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function persistPanel(panel) {
    if (!desktopMode()) return;
    const key = panel.dataset.panel;
    layout[key] = {
      left: panel.style.left,
      top: panel.style.top,
      zIndex: panel.style.zIndex
    };
    savePanelLayout(layout);
  }

  function focusPanel(panel) {
    zIndex += 1;
    panel.style.zIndex = String(zIndex);
    persistPanel(panel);
  }

  function applySavedLayout(panel) {
    const key = panel.dataset.panel;
    const saved = layout[key];
    if (!saved || !desktopMode()) return;
    if (saved.left) panel.style.left = saved.left;
    if (saved.top) panel.style.top = saved.top;
    if (saved.zIndex) {
      const savedZ = Number(saved.zIndex);
      if (Number.isFinite(savedZ)) {
        panel.style.zIndex = String(savedZ);
        zIndex = Math.max(zIndex, savedZ);
      }
    }
    clampPanel(panel);
  }

  panels.forEach((panel) => {
    applySavedLayout(panel);
    panel.addEventListener('pointerdown', () => focusPanel(panel));

    const header = panel.querySelector('.panel-header');
    if (!header) return;

    header.addEventListener('pointerdown', (event) => {
      if (!desktopMode()) return;
      if (event.target.closest('button, input, textarea, select, a')) return;
      focusPanel(panel);
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = parseFloat(panel.style.left || String(panel.offsetLeft));
      const startTop = parseFloat(panel.style.top || String(panel.offsetTop));

      header.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => {
        const nextLeft = startLeft + (moveEvent.clientX - startX);
        const nextTop = startTop + (moveEvent.clientY - startY);
        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
        clampPanel(panel);
      };

      const onUp = () => {
        header.releasePointerCapture(event.pointerId);
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        header.removeEventListener('pointercancel', onUp);
        persistPanel(panel);
      };

      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    });
  });

  window.addEventListener('resize', () => {
    panels.forEach((panel) => clampPanel(panel));
  });
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
  const desktop = document.getElementById('desktop');

  enablePanels(desktop);

  const state = {
    graph: null,
    view: null,
    selectedId: null,
    filterText: '',
    lastSearchQuery: '',
    lastLiveMtime: 0,
    pollTimer: null,
    loadInFlight: false
  };

  function renderNotes() {
    if (!state.graph) return;
    const outCounts = new Map();
    const inCounts = new Map();
    for (const e of state.graph.edges) {
      if (e.kind === 'link') {
        outCounts.set(e.source, (outCounts.get(e.source) || 0) + 1);
        inCounts.set(e.target, (inCounts.get(e.target) || 0) + 1);
      }
    }

    const q = state.filterText.toLowerCase();
    list.innerHTML = '';
    state.graph.nodes
      .filter((n) => n.type === 'note' && n.title.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach((n) => {
        const li = document.createElement('li');
        const oc = outCounts.get(n.id) || 0;
        const ic = inCounts.get(n.id) || 0;
        li.innerHTML = `${escapeHtml(n.title)} <span class="note-meta">(→${oc} ←${ic})</span>`;
        li.dataset.id = n.id;
        list.appendChild(li);
      });
  }

  async function select(id) {
    if (!state.graph) return;
    state.selectedId = id;
    const node = state.graph.nodes.find((n) => n.id === id);
    if (!node) return;
    if (state.view) {
      state.view.stop();
      state.view = drawGraph(canvas, state.graph, id);
    }

    const out = [];
    out.push(`<h3>${escapeHtml(node.title)}</h3><p><code>${escapeHtml(node.id)}</code></p>`);
    const outEdges = state.graph.edges.filter((e) => e.source === id);
    const inEdges = state.graph.edges.filter((e) => e.target === id);

    if (outEdges.length) {
      out.push('<h4>Links</h4><ul>' + outEdges
        .map((e) => `<li>${escapeHtml(state.graph.nodes.find((n) => n.id === e.target)?.title || e.target)}</li>`)
        .join('') + '</ul>');
    }
    if (inEdges.length) {
      out.push('<h4>Backlinks</h4><ul>' + inEdges
        .map((e) => `<li>${escapeHtml(state.graph.nodes.find((n) => n.id === e.source)?.title || e.source)}</li>`)
        .join('') + '</ul>');
    }

    try {
      const response = await fetch(`/note?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const note = await response.json();
      if (note && note.text) {
        const preview = note.text.split('\n').slice(0, 40).join('\n');
        out.push(`<h4>Preview</h4><pre class="snippet">${escapeHtml(preview)}</pre>`);
        out.push('<div class="actions"><button id="openNote">Open in Editor</button></div>');
      }
      info.innerHTML = out.join('\n');
      const openBtn = document.getElementById('openNote');
      if (openBtn) {
        openBtn.onclick = () => {
          fetch(`/open?id=${encodeURIComponent(id)}`).catch(() => {});
        };
      }
    } catch {
      info.innerHTML = out.join('\n');
    }
  }

  async function runSearch() {
    const q = (search.value || '').trim();
    if (q.length < 2) return;
    state.lastSearchQuery = q;
    status.textContent = 'Searching...';
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q })
    });
    if (!res.ok) {
      status.textContent = 'Search error';
      return;
    }

    const data = await res.json();
    const results = data.results || [];
    const out = [`<h3>Search results (${results.length})</h3>`];
    out.push('<ul>' + results.map((r) => (
      `<li data-id="${escapeHtml(r.id)}"><strong>${escapeHtml(r.title)}</strong> ` +
      `<span class="note-meta">(score ${escapeHtml(r.score)})</span>` +
      `<div class="snippet">${escapeHtml(r.snippet)}</div></li>`
    )).join('') + '</ul>');
    info.innerHTML = out.join('\n');
    info.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        const id = li.getAttribute('data-id');
        if (id) select(id);
      });
    });
    status.textContent = 'Search complete';
  }

  async function load(options = {}) {
    const { silent = false } = options;
    if (state.loadInFlight) return;
    state.loadInFlight = true;
    try {
      if (!silent) status.textContent = 'Loading...';
      const graph = await fetchGraph();
      state.graph = graph;
      if (state.view) state.view.stop();
      state.view = drawGraph(canvas, graph, state.selectedId);
      renderNotes();
      status.textContent = `${graph.nodes.length} nodes, ${graph.edges.length} edges`;

      if (state.selectedId && graph.nodes.some((n) => n.id === state.selectedId)) {
        await select(state.selectedId);
      } else if (state.lastSearchQuery) {
        await runSearch();
      } else if (!info.innerHTML.trim()) {
        info.innerHTML = '<p class="note-meta">Select a note, search the vault, or wait for live updates.</p>';
      }
    } catch (error) {
      status.textContent = 'Error loading graph';
      console.error(error);
    } finally {
      state.loadInFlight = false;
    }
  }

  async function pollLiveUpdates() {
    try {
      const live = await fetchLiveState();
      if (!live.enabled) return;
      const mtime = Number(live.mtimeMs || 0);
      if (!state.lastLiveMtime) {
        state.lastLiveMtime = mtime;
        return;
      }
      if (mtime > state.lastLiveMtime) {
        state.lastLiveMtime = mtime;
        status.textContent = 'Live update detected...';
        await load({ silent: true });
        return;
      }
      state.lastLiveMtime = mtime;
    } catch (error) {
      console.error('Live update poll failed', error);
    }
  }

  filter.addEventListener('input', () => {
    state.filterText = filter.value || '';
    renderNotes();
  });

  list.addEventListener('click', (event) => {
    const li = event.target.closest('li');
    if (!li) return;
    select(li.dataset.id);
  });

  reload.onclick = () => load();
  searchBtn.onclick = runSearch;
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!state.graph || !state.view) return;
    state.view.stop();
    state.view = drawGraph(canvas, state.graph, state.selectedId);
  });
  resizeObserver.observe(canvas);

  await load();
  state.pollTimer = setInterval(pollLiveUpdates, 2000);
}

main();
