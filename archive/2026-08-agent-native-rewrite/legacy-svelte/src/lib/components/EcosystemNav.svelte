<script lang="ts">
  export let current: 'notch' | 'browser' | 'create' | 'workspace';

  const modes = [
    { id: 'notch', label: 'Notch', href: '/notch' },
    { id: 'browser', label: 'Browser', href: '/browser' },
    { id: 'create', label: 'Create', href: '/create' }
  ] as const;
</script>

<nav class="hii-ecosystem-nav" aria-label="HII modes">
  {#each modes as mode}
    <a href={mode.href} class:is-active={current === mode.id}>{mode.label}</a>
  {/each}
  <a href="/workspace" class:is-active={current === 'workspace'}>Workspace</a>
</nav>

<style>
  .hii-ecosystem-nav { display:flex; align-items:center; gap:4px; width:max-content; padding:4px; border:1px solid rgba(18,21,24,.1); border-radius:999px; background:rgba(255,255,255,.88); box-shadow:0 10px 34px rgba(23,30,38,.08); backdrop-filter:blur(18px); }
  a { border-radius:999px; padding:8px 14px; color:#777b80; font:650 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; text-decoration:none; text-transform:uppercase; }
  a:hover { color:#111317; }
  a.is-active { background:#111317; color:white; }
</style>
