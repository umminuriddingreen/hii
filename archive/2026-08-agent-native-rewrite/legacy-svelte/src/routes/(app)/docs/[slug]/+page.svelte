<script lang="ts">
  import HiiDocsShell from '$lib/components/docs/HiiDocsShell.svelte';
  import type { PageData } from './$types';
  export let data: PageData;
</script>

<HiiDocsShell
  catalog={data.catalog}
  active={data.document.slug}
  title={data.document.title}
  description={data.document.description}
  source={data.document.source}
  status={data.document.status}
  compiledAt={data.document.compiledAt}
  markdown={data.document.markdown}
/>
