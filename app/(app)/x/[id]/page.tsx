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
    <div className="hii-page max-w-3xl">
      <header className="hii-page-header">
        <p className="hii-kicker">HII exchange</p>
        <h1 className="hii-page-title">{link.asset.title}</h1>
        <p className="hii-page-copy text-sm">
          {link.license ? `${link.license.name} · ${link.license.exclusivity}` : 'No license set'} · {price}
          {link.seller_name && <> · by {link.seller_name}</>}
        </p>
      </header>

      {link.asset.description && (
        <p className="mt-4 whitespace-pre-line text-neutral-700">{link.asset.description}</p>
      )}

      <div className="hii-card mt-6 bg-[var(--hii-soft-blue)] text-center text-neutral-700">
        File unlocks after payment. You&apos;ll get a 5-minute secure download link.
      </div>

      {link.license?.terms && (
        <div className="hii-card mt-4 text-sm text-neutral-600">
          <p className="font-medium text-neutral-700">Terms</p>
          <p className="mt-1 whitespace-pre-line">{link.license.terms}</p>
        </div>
      )}

      <form method="POST" action="/api/checkout" className="mt-6">
        <input type="hidden" name="link_id" value={link.id} />
        <button className="hii-command-button w-full py-3">
          Buy &amp; download - {price}
        </button>
      </form>
    </div>
  );
}
