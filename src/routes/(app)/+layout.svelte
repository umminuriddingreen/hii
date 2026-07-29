<script lang="ts">
  import { page } from '$app/stores';
  import DeskSurfaceShell from '$lib/components/DeskSurfaceShell.svelte';

  const surfaces: Record<string, { title: string; id: string; flush?: boolean }> = {
    '/activate': { title: 'Activation', id: 'activate', flush: true },
    '/boards': { title: 'Boards', id: 'boards' },
    '/console': { title: 'Console', id: 'console', flush: true },
    '/credits': { title: 'Credits', id: 'credits' },
    '/dashboard': { title: 'Dashboard', id: 'dashboard' },
    '/feed': { title: 'Feed', id: 'feed' },
    '/login': { title: 'Sign in', id: 'login' },
    '/pilot': { title: 'Founder pilot', id: 'pilot', flush: true },
    '/terminal': { title: 'Terminal', id: 'console', flush: true },
    '/termite': { title: 'Termite', id: 'termite' },
    '/trader': { title: 'Trader', id: 'trader', flush: true },
    '/upload': { title: 'Exchange', id: 'upload' }
  };

  $: embedded = $page.url.searchParams.get('desk') === '1';
  $: current = surfaces[$page.url.pathname] || { title: 'HII', id: 'workspace' };
</script>

{#if $page.url.pathname === '/landing'}
  <slot />
{:else if embedded}
  <div class="hii-desk-embedded" data-surface={current.id}><slot /></div>
{:else}
  <DeskSurfaceShell title={current.title} surface={current.id} flush={Boolean(current.flush)}><slot /></DeskSurfaceShell>
{/if}
