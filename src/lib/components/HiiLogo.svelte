<script lang="ts">
  export let className = '';
  export let title: string | undefined = undefined;
</script>

<span
  class={`hii-wordmark ${className}`}
  role={title ? 'img' : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : 'true'}
>
  hii
</span>

<style>
  .hii-wordmark {
    display: inline-block;
    flex: none;
    color: currentColor;
    font-family: Helvetica, "Helvetica Neue", Arial, sans-serif;
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.085em;
    line-height: 0.8;
    white-space: nowrap;
  }

  .hii-wordmark.h-4 { font-size: 1rem; }
  .hii-wordmark.h-5 { font-size: 1.25rem; }
</style>
