<script lang="ts">
  import WorkspacePage from '$lib/components/workspace/WorkspacePage.svelte';
  import type { PageData } from './$types';

  export let data: PageData;
</script>

<WorkspacePage {data} />
