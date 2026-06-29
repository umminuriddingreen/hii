<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

<div class="min-h-screen bg-neutral-950 text-neutral-100">
  <header class="border-b border-neutral-800 px-6 py-4">
    <a href="/" class="font-mono text-lg font-bold">hii</a>
    <span class="ml-3 text-sm text-neutral-500">exchange a file for value</span>
  </header>
  <main class="mx-auto max-w-2xl px-6 py-10">
    {@render children()}
  </main>
</div>
