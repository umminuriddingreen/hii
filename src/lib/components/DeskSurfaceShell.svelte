<script lang="ts">
  import HiiLogo from '$lib/components/HiiLogo.svelte';

  export let title = 'Workspace';
  export let surface = 'workspace';
  export let flush = false;

  const rail = [
    { href: '/knowledge', id: 'knowledge', glyph: 'K', label: 'Knowledge' },
    { href: '/activate', id: 'activate', glyph: '✦', label: 'Activate' },
    { href: '/boards', id: 'boards', glyph: 'B', label: 'Boards' },
    { href: '/console', id: 'console', glyph: '›_', label: 'Console' }
  ];
  const dock = [
    { href: '/', id: 'desk', label: 'desk' },
    { href: '/knowledge', id: 'knowledge', label: 'knowledge' },
    { href: '/activate', id: 'activate', label: 'activate' },
    { href: '/boards', id: 'boards', label: 'boards' },
    { href: '/console', id: 'console', label: 'console' },
    { href: '/pilot', id: 'pilot', label: 'pilot' }
  ];
</script>

<div class="hii-desk-surface-shell" data-surface={surface}>
  <a class="hii-desk-surface-brand" href="/" aria-label="HII Desk"><HiiLogo /></a>

  <nav class="hii-desk-surface-rail" aria-label="HII Desk tools">
    {#each rail as item}
      <a href={item.href} class:is-active={surface === item.id} aria-label={item.label} title={item.label}>{item.glyph}</a>
    {/each}
  </nav>

  <section class="hii-desk-surface-window">
    <header>
      <div><i></i><span>HII Desk</span><b>/</b><strong>{title}</strong></div>
      <div><span class="hii-desk-surface-local"><i></i>local</span><a href="/" aria-label="Close surface">×</a></div>
    </header>
    <div class:hii-desk-surface-flush={flush} class="hii-desk-surface-content"><slot /></div>
  </section>

  <nav class="hii-desk-surface-dock" aria-label="HII surfaces">
    {#each dock as item}
      <a href={item.href} class:is-active={surface === item.id}>{item.label}</a>
    {/each}
  </nav>

  <span class="hii-desk-surface-daemon"><i></i>hiid</span>
</div>
