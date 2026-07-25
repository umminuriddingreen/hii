<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;

  const text = (key: string) => String(node.payload[key] ?? '');
  const readableSize = (value: unknown) => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  $: url = text('url');
  $: name = text('name') || 'Document';
  $: checksum = text('sha256');
  $: source = node.object?.source || '';
  $: pdfUrl = `${url}#view=FitH&toolbar=1&navpanes=0`;
</script>

<div class="flex h-full min-h-0 flex-col bg-[#e9e7e2]">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-black/10 bg-white px-3">
    <span class="rounded-full bg-red-50 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-red-600">PDF</span>
    <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-700">{name}</span>
    <span class="font-mono text-[9px] text-neutral-400">{readableSize(node.payload.size)}</span>
    <a href={url} target="_blank" rel="noreferrer" class="rounded-full border px-2 py-1 font-mono text-[9px] hover:bg-neutral-50">open ↗</a>
    <a href={url} download={name} class="rounded-full bg-neutral-950 px-2 py-1 font-mono text-[9px] text-white">save ↓</a>
  </div>
  <iframe src={pdfUrl} title={`Document viewer for ${name}`} class="min-h-0 flex-1 border-0 bg-white"></iframe>
  <footer class="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-black/10 bg-white px-3 font-mono text-[9px] text-neutral-400">
    <span class="min-w-0 truncate" title={source}>local source · {source || name}</span>
    <span class="shrink-0">{checksum ? `sha256 ${checksum.slice(0, 10)}…` : node.payload.ephemeral ? 'session only' : 'stored locally'}</span>
  </footer>
</div>
