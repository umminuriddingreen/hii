<script lang="ts">
  let { form } = $props();
</script>

<h1 class="text-2xl font-bold">Upload a track</h1>

{#if form?.assetUrl}
  <div class="mt-6 rounded border border-emerald-700 bg-emerald-950/40 p-4">
    <p class="text-emerald-300">Track created. Send this link to your buyer:</p>
    <a href={form.assetUrl} class="mt-2 block break-all font-mono text-sm underline">
      {form.assetUrl}
    </a>
  </div>
{/if}

<form
  method="POST"
  enctype="multipart/form-data"
  class="mt-6 space-y-4"
>
  <label class="block">
    <span class="text-sm text-neutral-400">Title</span>
    <input name="title" required class="mt-1 w-full rounded bg-neutral-900 px-3 py-2" />
  </label>

  <label class="block">
    <span class="text-sm text-neutral-400">Price (USD)</span>
    <input
      name="price"
      type="number"
      min="0"
      step="0.01"
      value="9.99"
      required
      class="mt-1 w-full rounded bg-neutral-900 px-3 py-2"
    />
  </label>

  <label class="block">
    <span class="text-sm text-neutral-400">License</span>
    <select name="license" class="mt-1 w-full rounded bg-neutral-900 px-3 py-2">
      <option value="non-exclusive">Non-exclusive</option>
      <option value="exclusive">Exclusive</option>
      <option value="lease">Lease</option>
    </select>
  </label>

  <label class="block">
    <span class="text-sm text-neutral-400">Audio file</span>
    <input name="file" type="file" accept="audio/*" required class="mt-1 block w-full text-sm" />
  </label>

  {#if form?.error}
    <p class="text-red-400">{form.error}</p>
  {/if}

  <button class="rounded bg-emerald-500 px-5 py-2 font-medium text-black hover:bg-emerald-400">
    Create link
  </button>
</form>
