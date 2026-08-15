<script lang="ts">
  export let compact = false;
  $: bars = compact ? 3 : 5;
</script>

<div aria-label="alive" class:hii-alive-bars-compact={compact} class="hii-alive-bars">
  {#each Array(bars) as _, index}
    <span style:animation-delay={`${index * 120}ms`}></span>
  {/each}
</div>
