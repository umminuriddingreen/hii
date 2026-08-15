<script lang="ts">
  export let path = '/knowledge';
  export let title = 'HII surface';

  $: src = `${path}${path.includes('?') ? '&' : '?'}desk=1`;
</script>

<div class="hii-surface-pane">
  <iframe {src} {title}></iframe>
</div>

<style>
  .hii-surface-pane,
  iframe {
    width: 100%;
    height: 100%;
  }

  .hii-surface-pane {
    background: var(--hii-warm-white);
  }

  iframe {
    display: block;
    border: 0;
    background: var(--hii-warm-white);
  }
</style>
