<script lang="ts">
  import { page } from '$app/stores';
  import DeskSurfaceShell from '$lib/components/DeskSurfaceShell.svelte';

  const surfaces: Record<string, { title: string; id: string; flush?: boolean }> = {
    '/browser': { title: 'Browser', id: 'browser', flush: true },
    '/create': { title: 'Create', id: 'create', flush: true },
    '/activate': { title: 'Activation', id: 'activate', flush: true },
    '/boards': { title: 'Boards', id: 'boards' },
    '/console': { title: 'Console', id: 'console', flush: true },
    '/pilot': { title: 'Founder pilot', id: 'pilot', flush: true }
  };

  $: embedded = $page.url.searchParams.get('desk') === '1';
  $: current = $page.url.pathname.startsWith('/docs')
    ? { title: 'Documentation', id: 'docs', flush: true }
    : surfaces[$page.url.pathname] || { title: 'HII', id: 'workspace' };
</script>

{#if $page.url.pathname === '/landing'}
  <slot />
{:else if embedded}
  <div class="hii-desk-embedded" data-surface={current.id}><slot /></div>
{:else}
  <DeskSurfaceShell title={current.title} surface={current.id} flush={Boolean(current.flush)}><slot /></DeskSurfaceShell>
{/if}
