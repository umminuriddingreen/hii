<script lang="ts">
  let { data } = $props();
  const t = data.track;
  const price = (t.price_cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: t.currency.toUpperCase()
  });
</script>

<h1 class="text-2xl font-bold">{t.title}</h1>
<p class="mt-1 text-neutral-400">{t.license} license · {price}</p>

<!-- Preview: a watermarked clip will go here; raw file stays locked until paid -->
<div class="mt-6 rounded border border-neutral-800 bg-neutral-900 p-6 text-center text-neutral-500">
  ♪ preview clip (coming after payment path proves out)
</div>

<form method="POST" action="/api/checkout" class="mt-6">
  <input type="hidden" name="track_id" value={t.id} />
  <button class="w-full rounded bg-emerald-500 px-5 py-3 font-medium text-black hover:bg-emerald-400">
    Buy &amp; download — {price}
  </button>
</form>

<p class="mt-8 text-xs text-neutral-600">
  Downloads so far: {data.downloadCount}
</p>
