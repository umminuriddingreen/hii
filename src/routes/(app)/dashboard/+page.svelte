<script lang="ts">
  let { data } = $props();
  const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const assetTitle = (link: { asset?: { title?: string } | { title?: string }[] | null }) => {
    const asset = Array.isArray(link.asset) ? link.asset[0] : link.asset;
    return asset?.title ?? '—';
  };
</script>
<div class="hii-page"><header class="hii-page-header flex items-start justify-between gap-4"><div><p class="hii-kicker">HII dashboard</p><h1 class="hii-page-title">Exchange receipts</h1><p class="mt-3 text-sm text-neutral-500">{data.email}</p></div><form method="POST" action="/auth/signout"><button class="hii-secondary-action">Sign out</button></form></header>
{#if data.warning}<p class="hii-card mt-5 text-amber-700">{data.warning}</p>{/if}<div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">{#each [['Views',data.links.reduce((s:any,l:any)=>s+(l.views??0),0)],['Sales',data.sales],['Downloads',data.downloads],['Revenue',usd(data.revenue)]] as stat}<div class="hii-stat-card"><div class="text-xs uppercase tracking-wide text-neutral-500">{stat[0]}</div><div class="mt-1 text-2xl font-bold">{stat[1]}</div></div>{/each}</div>
<h2 class="mt-10 text-lg font-semibold">Exchange links</h2><div class="hii-card mt-3 overflow-x-auto"><table class="w-full text-left text-sm"><thead class="text-neutral-500"><tr><th class="py-2">Asset</th><th>Price</th><th>Views</th><th>Sales</th><th>Link</th></tr></thead><tbody>{#each data.links as link}<tr class="border-t border-[rgba(23,107,255,.18)]"><td class="py-2">{assetTitle(link)}</td><td>{usd(link.price_cents)}</td><td>{link.views}</td><td>{data.salesByLink[link.id]??0}</td><td><a href={`/x/${link.id}`} class="hii-resource-link font-mono text-xs">/x/{link.id.slice(0,8)}…</a></td></tr>{:else}<tr><td colspan="5" class="py-6 text-neutral-400">No exchanges yet. <a href="/upload" class="hii-resource-link">Create one</a></td></tr>{/each}</tbody></table></div>
<h2 class="mt-10 text-lg font-semibold">Buyers</h2>{#if data.buyers.length}<ul class="mt-3 space-y-1 text-sm">{#each data.buyers as buyer}<li class="font-mono">{buyer}</li>{/each}</ul>{:else}<p class="mt-3 text-sm text-neutral-400">No buyers yet.</p>{/if}</div>
