<script lang="ts">
  export let className = '';
  export let title: string | undefined = undefined;
</script>

<svg
  viewBox="0 0 84 52"
  class={className}
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  role={title ? 'img' : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : 'true'}
  focusable="false"
  shape-rendering="geometricPrecision"
>
  <path d="M4 4h10v17.25C17.2 15.05 22.4 12 29.6 12 40.45 12 46 18.65 46 31.3V48H36V32.15c0-7.7-2.95-11.25-9.15-11.25C18.9 20.9 14 26.15 14 35.2V48H4V4Z" fill="currentColor" />
  <rect x="53" y="20" width="10" height="28" fill="currentColor" />
  <rect x="69" y="20" width="10" height="28" fill="currentColor" />
  <circle cx="58" cy="9" r="5" fill="currentColor" />
  <rect x="69" y="4" width="10" height="10" rx="1" fill="currentColor" />
</svg>
