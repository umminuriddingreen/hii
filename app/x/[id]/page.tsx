import { notFound } from 'next/navigation';
import { getExchangeLink, incrementLinkViews } from '@/lib/server/data';

/** Public buyer page: preview the asset + terms, then pay to unlock download. */
export default async function ExchangePage({ params }: { params: { id: string } }) {
  const link = await getExchangeLink(params.id);
  if (!link) notFound();

  // Best-effort view count for seller analytics.
  incrementLinkViews(link.id).catch(() => {});

  const price = (link.price_cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: link.currency.toUpperCase()
  });

  return (
    <>
      <h1 className="text-2xl font-bold">{link.asset.title}</h1>
      <p className="mt-1 text-neutral-600">
        {link.license ? `${link.license.name} · ${link.license.exclusivity}` : 'No license set'} · {price}
        {link.seller_name && <> · by {link.seller_name}</>}
      </p>

      {link.asset.description && (
        <p className="mt-4 whitespace-pre-line text-neutral-700">{link.asset.description}</p>
      )}

      <div className="mt-6 rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-neutral-500">
        🔒 file unlocks after payment — you&apos;ll get a 5-minute secure download link
      </div>

      {link.license?.terms && (
        <div className="mt-4 rounded border border-neutral-200 p-4 text-sm text-neutral-600">
          <p className="font-medium text-neutral-700">Terms</p>
          <p className="mt-1 whitespace-pre-line">{link.license.terms}</p>
        </div>
      )}

      <form method="POST" action="/api/checkout" className="mt-6">
        <input type="hidden" name="link_id" value={link.id} />
        <button className="w-full rounded bg-black px-5 py-3 font-medium text-white hover:bg-neutral-800">
          Buy &amp; download — {price}
        </button>
      </form>
    </>
  );
}
