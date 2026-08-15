<script lang="ts">
  import HiiDocsShell from '$lib/components/docs/HiiDocsShell.svelte';
  import type { PageData } from './$types';
  export let data: PageData;
</script>

<HiiDocsShell
  catalog={data.catalog}
  title="HII field manual"
  description="Product truth, user guidance, architecture, operations, and decisions—compiled from the live HII repository."
/>
