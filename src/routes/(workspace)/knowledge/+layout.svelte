<script lang="ts">
  import { page } from '$app/stores';
  import DeskSurfaceShell from '$lib/components/DeskSurfaceShell.svelte';

  $: embedded = $page.url.searchParams.get('desk') === '1';
</script>

{#if embedded}
  <div class="hii-desk-embedded hii-knowledge-root" data-surface="knowledge"><slot /></div>
{:else}
  <DeskSurfaceShell title="Knowledge" surface="knowledge" flush><div class="hii-knowledge-root"><slot /></div></DeskSurfaceShell>
{/if}
