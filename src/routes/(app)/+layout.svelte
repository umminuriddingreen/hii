<script lang="ts">
  import { page } from '$app/stores';
  import AliveBars from '$lib/components/AliveBars.svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';
</script>

{#if $page.url.pathname === '/landing'}
  <slot />
{:else}
  <div class="hii-app-shell">
    <AliveBars />
    <header class="hii-topbar sticky top-0 z-40 px-4 py-3 sm:px-6">
      <div class="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div class="flex items-baseline gap-3">
          <a href="/" class="text-[var(--hii-electric-blue)]" aria-label="HII home"><HiiLogo className="h-5 w-auto" /></a>
          <span class="font-mono text-xs uppercase text-neutral-600">control plane</span>
        </div>
        <nav class="flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="HII product">
          <a href="/" class="hii-nav-link">Desk</a><a href="/landing" class="hii-nav-link">Playbook</a>
          <a href="/feed" class="hii-nav-link">Feed</a><a href="/knowledge" class="hii-nav-link">Knowledge</a>
          <a href="/boards" class="hii-nav-link">Boards</a><a href="/console" class="hii-nav-link">Console</a>
          <a href="/credits" class="hii-nav-link">Credits</a><a href="/termite" class="hii-nav-link">Termite</a>
          <a href="/upload" class="hii-nav-link">Exchange</a><a href="/dashboard" class="hii-nav-link">Dashboard</a>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-10"><slot /></main>
  </div>
{/if}
