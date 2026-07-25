<script lang="ts">
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;
</script>

<article class="flex h-full flex-col justify-between bg-[#fffdf8] px-5 py-4">
  <p class="whitespace-pre-wrap text-[18px] font-medium leading-[1.25] text-neutral-900">
    {String(node.payload.text || node.payload.prompt || 'Untitled intent')}
  </p>
  <footer class="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-400">
    <span>you · approved intent</span>
    <span>{node.object?.parentId ? 'follow-up branch' : 'workspace root'}</span>
  </footer>
</article>
