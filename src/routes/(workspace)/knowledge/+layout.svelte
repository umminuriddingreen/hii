<script lang="ts">
  import AliveBars from '$lib/components/AliveBars.svelte';
  import HiiLogo from '$lib/components/HiiLogo.svelte';
</script>

<div class="hii-knowledge-root">
  <AliveBars />
  <header class="hii-knowledge-topbar">
    <div class="flex min-w-0 items-center gap-3"><a href="/" class="hii-knowledge-mark" aria-label="HII home"><HiiLogo /></a><span class="hii-knowledge-slash">/</span><span class="truncate font-mono text-xs font-semibold uppercase tracking-[0.16em]">knowledge</span></div>
    <div class="flex items-center gap-2 font-mono text-[11px] text-neutral-500"><span class="hii-knowledge-local"><i></i> local</span><a href="/boards" class="hii-knowledge-toplink">boards</a><a href="/console" class="hii-knowledge-toplink">console</a></div>
  </header>
  <slot />
</div>
