<script lang="ts">
  import { onMount } from 'svelte';
  import { parseDxf, type DxfDrawing, type DxfPrimitive } from '@/lib/workspace/dxf';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;

  const palette = ['#69a7ff', '#70d6a3', '#ffd166', '#ef7f9b', '#c59cff', '#78d7e8', '#ff9f68', '#d8e27a'];
  let svg: SVGSVGElement;
  let status: 'loading' | 'ready' | 'failed' = 'loading';
  let error = '';
  let drawing: DxfDrawing | null = null;
  let hiddenLayers = new Set<string>();
  let view = { x: 0, y: 0, w: 100, h: 100 };
  let panning = false;
  let panStart = { clientX: 0, clientY: 0, x: 0, y: 0 };

  $: url = String(node.payload.url || '');
  $: name = String(node.payload.name || 'CAD drawing');
  $: checksum = String(node.payload.sha256 || '');
  $: source = String(node.object?.source || node.payload.path || name);
  $: visiblePrimitives = drawing?.primitives.filter((primitive) => !hiddenLayers.has(primitive.layer)) || [];

  function layerColor(layer: string) {
    let hash = 0;
    for (const character of layer) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
  }

  function frameDrawing() {
    if (!drawing) return;
    const width = Math.max(drawing.bounds.maxX - drawing.bounds.minX, 1);
    const height = Math.max(drawing.bounds.maxY - drawing.bounds.minY, 1);
    const padding = Math.max(width, height) * 0.06;
    view = {
      x: drawing.bounds.minX - padding,
      y: -drawing.bounds.maxY - padding,
      w: width + padding * 2,
      h: height + padding * 2
    };
  }

  function polylinePoints(primitive: Extract<DxfPrimitive, { kind: 'polyline' }>) {
    const points = primitive.points.map((point) => `${point.x},${-point.y}`);
    if (primitive.closed && points.length) points.push(points[0]);
    return points.join(' ');
  }

  function arcPath(primitive: Extract<DxfPrimitive, { kind: 'arc' }>) {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const start = {
      x: primitive.center.x + primitive.radius * Math.cos(radians(primitive.startAngle)),
      y: -(primitive.center.y + primitive.radius * Math.sin(radians(primitive.startAngle)))
    };
    const end = {
      x: primitive.center.x + primitive.radius * Math.cos(radians(primitive.endAngle)),
      y: -(primitive.center.y + primitive.radius * Math.sin(radians(primitive.endAngle)))
    };
    const delta = (primitive.endAngle - primitive.startAngle + 360) % 360;
    return `M ${start.x} ${start.y} A ${primitive.radius} ${primitive.radius} 0 ${delta > 180 ? 1 : 0} 0 ${end.x} ${end.y}`;
  }

  function zoom(event: WheelEvent) {
    if (!svg || status !== 'ready') return;
    const rect = svg.getBoundingClientRect();
    const x = view.x + ((event.clientX - rect.left) / rect.width) * view.w;
    const y = view.y + ((event.clientY - rect.top) / rect.height) * view.h;
    const factor = event.deltaY > 0 ? 1.14 : 0.86;
    const nextW = Math.min(Math.max(view.w * factor, 0.001), 1e9);
    const nextH = Math.min(Math.max(view.h * factor, 0.001), 1e9);
    view = {
      x: x - ((x - view.x) / view.w) * nextW,
      y: y - ((y - view.y) / view.h) * nextH,
      w: nextW,
      h: nextH
    };
  }

  function startPan(event: PointerEvent) {
    if (status !== 'ready') return;
    panning = true;
    panStart = { clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
    svg.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (!panning || !svg) return;
    const rect = svg.getBoundingClientRect();
    view = {
      ...view,
      x: panStart.x - ((event.clientX - panStart.clientX) / rect.width) * view.w,
      y: panStart.y - ((event.clientY - panStart.clientY) / rect.height) * view.h
    };
  }

  function endPan(event: PointerEvent) {
    panning = false;
    svg?.releasePointerCapture(event.pointerId);
  }

  function toggleLayer(layer: string) {
    const next = new Set(hiddenLayers);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    hiddenLayers = next;
  }

  onMount(() => {
    const controller = new AbortController();
    if (!url) {
      status = 'failed';
      error = 'The local DXF URL is missing.';
      return () => controller.abort();
    }
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HII could not read this DXF (${response.status}).`);
        return response.text();
      })
      .then((sourceText) => {
        drawing = parseDxf(sourceText);
        frameDrawing();
        status = 'ready';
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        status = 'failed';
        error = reason instanceof Error ? reason.message : 'HII could not decode this DXF.';
      });
    return () => controller.abort();
  });
</script>

<div class="relative h-full min-h-0 overflow-hidden bg-[#0f1218] text-white">
  <svg
    bind:this={svg}
    role="img"
    aria-label={`Interactive DXF viewer for ${name}`}
    viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
    preserveAspectRatio="xMidYMid meet"
    class:cursor-grabbing={panning}
    class="h-full w-full cursor-grab touch-none select-none"
    on:wheel|preventDefault|stopPropagation={zoom}
    on:pointerdown|stopPropagation={startPan}
    on:pointermove|stopPropagation={movePan}
    on:pointerup|stopPropagation={endPan}
    on:pointercancel|stopPropagation={endPan}
  >
    <defs>
      <pattern id={`dxf-grid-${node.id}`} width={view.w / 20} height={view.w / 20} patternUnits="userSpaceOnUse">
        <path d={`M ${view.w / 20} 0 L 0 0 0 ${view.w / 20}`} fill="none" stroke="#ffffff" stroke-opacity="0.035" stroke-width={view.w / 3000} />
      </pattern>
    </defs>
    <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={`url(#dxf-grid-${node.id})`} />
    {#each visiblePrimitives as primitive}
      {@const color = layerColor(primitive.layer)}
      {#if primitive.kind === 'line'}
        <line x1={primitive.from.x} y1={-primitive.from.y} x2={primitive.to.x} y2={-primitive.to.y} stroke={color} vector-effect="non-scaling-stroke" />
      {:else if primitive.kind === 'polyline'}
        <polyline points={polylinePoints(primitive)} fill="none" stroke={color} vector-effect="non-scaling-stroke" />
      {:else if primitive.kind === 'circle'}
        <circle cx={primitive.center.x} cy={-primitive.center.y} r={primitive.radius} fill="none" stroke={color} vector-effect="non-scaling-stroke" />
      {:else if primitive.kind === 'arc'}
        <path d={arcPath(primitive)} fill="none" stroke={color} vector-effect="non-scaling-stroke" />
      {:else if primitive.kind === 'point'}
        <circle cx={primitive.point.x} cy={-primitive.point.y} r={Math.max(view.w / 500, 0.2)} fill={color} />
      {:else if primitive.kind === 'text'}
        <text x={primitive.point.x} y={-primitive.point.y} fill={color} font-size={primitive.height} font-family="ui-monospace, monospace">{primitive.text}</text>
      {/if}
    {/each}
  </svg>

  <div class="pointer-events-none absolute left-3 top-3 flex max-w-[70%] items-center gap-2 rounded-full border border-white/10 bg-[#151a23]/90 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-white/70 shadow-lg backdrop-blur">
    <span class="h-1.5 w-1.5 rounded-full" class:bg-emerald-400={status === 'ready'} class:bg-amber-300={status === 'loading'} class:bg-red-400={status === 'failed'}></span>
    <span>DXF · {status}</span>
    {#if drawing}<span class="text-white/35">{drawing.primitives.length} entities · {drawing.layers.length} layers · {drawing.units}</span>{/if}
  </div>

  <div class="absolute right-3 top-3 flex gap-1 rounded-full border border-white/10 bg-[#151a23]/90 p-1 shadow-lg backdrop-blur">
    <button class="rounded-full px-2.5 py-1 font-mono text-[9px] text-white/70 hover:bg-white/10" on:click={frameDrawing} disabled={status !== 'ready'}>frame</button>
    <a href={url} download={name} class="rounded-full px-2.5 py-1 font-mono text-[9px] text-white/70 hover:bg-white/10">save ↓</a>
  </div>

  {#if drawing}
    <aside class="scroll absolute bottom-11 left-3 max-h-[45%] w-44 overflow-auto rounded-xl border border-white/10 bg-[#151a23]/90 p-2 shadow-lg backdrop-blur">
      <p class="px-1 pb-1 font-mono text-[8px] uppercase tracking-[0.12em] text-white/35">drawing layers</p>
      {#each drawing.layers as layer}
        <button class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left font-mono text-[9px] hover:bg-white/5" class:opacity-35={hiddenLayers.has(layer)} on:click={() => toggleLayer(layer)}>
          <i class="h-1.5 w-1.5 rounded-full" style={`background:${layerColor(layer)}`}></i>
          <span class="min-w-0 flex-1 truncate">{layer}</span>
          <span class="text-white/25">{hiddenLayers.has(layer) ? 'off' : 'on'}</span>
        </button>
      {/each}
      {#if drawing.unsupported.length}<p class="mt-1 border-t border-white/10 px-1 pt-1 font-mono text-[8px] text-white/30" title={drawing.unsupported.join(', ')}>{drawing.unsupported.length} unsupported type{drawing.unsupported.length === 1 ? '' : 's'} skipped</p>{/if}
    </aside>
  {/if}

  {#if status === 'loading'}<div class="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[9px] uppercase tracking-[0.14em] text-white/35">reading local drawing…</div>{/if}
  {#if status === 'failed'}<div class="absolute inset-0 grid place-items-center bg-[#0f1218]/95 p-8 text-center"><div class="max-w-sm"><p class="font-mono text-[9px] uppercase tracking-[0.14em] text-red-400">DXF viewer could not open drawing</p><p class="mt-3 text-xs text-white/60">{error}</p></div></div>{/if}

  <footer class="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3 rounded-full border border-white/10 bg-[#151a23]/90 px-3 py-1.5 font-mono text-[9px] text-white/40 shadow-lg backdrop-blur">
    <span class="min-w-0 truncate" title={source}>local source · {source}</span>
    <span class="hidden shrink-0 md:inline">drag to pan · scroll to zoom · frame to reset</span>
    <span class="shrink-0">{checksum ? `sha256 ${checksum.slice(0, 10)}…` : node.payload.ephemeral ? 'session only' : 'stored locally'}</span>
  </footer>
</div>
