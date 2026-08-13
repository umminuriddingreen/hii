<script lang="ts">
  import LandingPage from './(app)/landing/+page.svelte';
  import HiiPresence from '$lib/components/HiiPresence.svelte';
  import type { PageData } from './$types';

  export let data: PageData;
</script>

{#if __HII_TARGET__ === 'web'}
  <LandingPage />
{:else}
  <HiiPresence {data} />
{/if}
