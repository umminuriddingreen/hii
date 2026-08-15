<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';
  import {
    normalizeWorkspaceContextAnchor,
    workspaceContextAnchorLabel
  } from '@/lib/workspace/context-anchor';

  export let node: WorkspaceNode;
  export let onPayload: (patch: Record<string, unknown>) => void = () => {};

  const text = (key: string) => String(node.payload[key] ?? '');
  const readableSize = (value: unknown) => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };
  const initialAnchor = normalizeWorkspaceContextAnchor(node.payload.contextAnchor);
  let pageStart = initialAnchor?.kind === 'document-range' ? initialAnchor.pageStart : 1;
  let pageEnd = initialAnchor?.kind === 'document-range' ? initialAnchor.pageEnd : pageStart;

  $: url = text('url');
  $: name = text('name') || 'Document';
  $: checksum = text('sha256');
  $: source = node.object?.source || '';
  $: anchor = normalizeWorkspaceContextAnchor(node.payload.contextAnchor);
  $: pdfUrl = `${url}#page=${Math.max(1, Math.floor(pageStart || 1))}&view=FitH&toolbar=1&navpanes=0`;

  function usePageRange() {
    const start = Math.max(1, Math.floor(Number(pageStart) || 1));
    const end = Math.max(start, Math.floor(Number(pageEnd) || start));
    pageStart = start;
    pageEnd = end;
    onPayload({
      contextAnchor: {
        kind: 'document-range',
        pageStart: start,
        pageEnd: end
      }
    });
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-[#e9e7e2]">
  <div role="group" aria-label="PDF focus controls" class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-black/10 bg-white px-3 py-1.5" on:pointerdown|stopPropagation>
    <span class="rounded-full bg-red-50 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-red-600">PDF</span>
    <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-700">{name}</span>
    <span class="font-mono text-[9px] text-neutral-400">{readableSize(node.payload.size)}</span>
    <label class="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 font-mono text-[8px] text-blue-700">
      pages
      <input aria-label="PDF focus start page" type="number" min="1" class="w-10 bg-transparent text-center outline-none" bind:value={pageStart}/>
      –
      <input aria-label="PDF focus end page" type="number" min="1" class="w-10 bg-transparent text-center outline-none" bind:value={pageEnd}/>
    </label>
    <button class="rounded-full bg-[var(--hii-electric-blue)] px-2 py-1 font-mono text-[8px] text-white" on:click={usePageRange}>use pages</button>
    {#if anchor}<button class="rounded-full px-2 py-1 font-mono text-[8px] text-neutral-400 hover:bg-neutral-100" on:click={()=>onPayload({contextAnchor:null})}>clear</button>{/if}
    <a href={url} target="_blank" rel="noreferrer" class="rounded-full border px-2 py-1 font-mono text-[9px] hover:bg-neutral-50">open ↗</a>
    <a href={url} download={name} class="rounded-full bg-neutral-950 px-2 py-1 font-mono text-[9px] text-white">save ↓</a>
  </div>
  <iframe src={pdfUrl} title={`Document viewer for ${name}`} class="min-h-0 flex-1 border-0 bg-white"></iframe>
  <footer class="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-black/10 bg-white px-3 font-mono text-[9px] text-neutral-400">
    <span class="min-w-0 truncate" title={source}>local source · {source || name}</span>
    {#if anchor}<span class="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">human focus · {workspaceContextAnchorLabel(anchor)}</span>{/if}
    <span class="shrink-0">{checksum ? `sha256 ${checksum.slice(0, 10)}…` : node.payload.ephemeral ? 'session only' : 'stored locally'}</span>
  </footer>
</div>
