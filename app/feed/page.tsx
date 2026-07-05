import Link from 'next/link';
import { getPublicFeed } from '@/lib/server/data';

export const dynamic = 'force-dynamic';

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default async function FeedPage() {
  const items = await getPublicFeed();

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-2 text-sm">
        <Link href="/feed" className="block rounded border border-black px-3 py-2 font-medium">Home feed</Link>
        <Link href="/boards" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Boards</Link>
        <Link href="/dashboard" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Studio</Link>
        <Link href="/terminal" className="block rounded border border-neutral-200 px-3 py-2 text-neutral-700">Terminal</Link>
        <div className="pt-4 font-mono text-xs text-neutral-500">
          /feed<br />
          /boards<br />
          /upload
        </div>
      </aside>

      <div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-neutral-500">people terminal</p>
          <h1 className="mt-2 text-3xl font-bold">Your network’s feed for useful information.</h1>
          <p className="mt-2 max-w-2xl text-sm text-neutral-600">
            Familiar like a social feed, organized like Pinterest, searchable like a terminal. Save what
            you know, host it yourself, and share it with connected people by default.
          </p>
        </div>
        <Link href="/upload" className="w-fit rounded border border-black px-4 py-2 text-sm font-medium">
          create post
        </Link>
      </div>

        <div className="mt-6 flex flex-wrap gap-2 text-xs">
          {['following', 'saved', 'boards', 'plugins', 'for sale'].map((filter) => (
            <span key={filter} className="rounded-full border border-neutral-200 px-3 py-1 text-neutral-600">
              {filter}
            </span>
          ))}
        </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <article key={item.id} className="flex min-h-64 flex-col rounded border border-neutral-200">
            <div className="flex min-h-36 flex-1 items-center justify-center border-b border-neutral-200 bg-neutral-50 p-6 text-center">
              <div>
                <div className="font-mono text-xs text-neutral-400">{item.asset.content_type}</div>
                <h2 className="mt-3 text-xl font-semibold">{item.asset.title}</h2>
              </div>
            </div>
            <div className="p-4">
              <p className="line-clamp-2 min-h-10 text-sm text-neutral-600">
                {item.asset.description || 'creator-owned information asset'}
              </p>
              <div className="mt-4 flex items-center justify-between gap-4 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{item.seller_name ?? 'creator'}</div>
                  {item.seller_handle && (
                    <div className="truncate font-mono text-xs text-neutral-500">@{item.seller_handle}</div>
                  )}
                </div>
                <div className="font-mono">{usd(item.price_cents)}</div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-neutral-500">
                <span>{item.views} views</span>
                <span>save</span>
                <span>share</span>
                <Link href={`/x/${item.id}`} className="font-medium text-black underline underline-offset-4">
                  open item
                </Link>
              </div>
            </div>
          </article>
        ))}
      </div>

      {items.length === 0 && (
        <div className="mt-10 rounded border border-dashed border-neutral-300 p-8 text-sm text-neutral-500">
          No network items are live yet. Save the first information asset from <Link href="/upload" className="underline">/upload</Link>.
        </div>
      )}
      </div>
    </div>
  );
}
