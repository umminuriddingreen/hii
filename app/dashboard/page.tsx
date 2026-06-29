import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** Step 6: seller analytics — views, sales, downloads, revenue, buyers. */
export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  // Pull the seller's own rows (RLS guarantees ownership).
  const [{ data: links }, { data: orders }, { data: downloads }] = await Promise.all([
    supabase
      .from('exchange_links')
      .select('id, price_cents, currency, views, active, asset:assets(title)')
      .order('created_at', { ascending: false }),
    supabase.from('orders').select('exchange_link_id, status, amount_cents, buyer_email, paid_at'),
    supabase.from('download_events').select('asset_id, order_id')
  ]);

  const paid = (orders ?? []).filter((o) => o.status === 'paid');
  const revenueCents = paid.reduce((s, o) => s + (o.amount_cents ?? 0), 0);
  const buyers = Array.from(
    new Set(paid.map((o) => o.buyer_email).filter((e): e is string => Boolean(e)))
  );
  const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const salesByLink = new Map<string, number>();
  for (const o of paid) salesByLink.set(o.exchange_link_id ?? '', (salesByLink.get(o.exchange_link_id ?? '') ?? 0) + 1);

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <form method="POST" action="/auth/signout">
          <button className="text-sm text-neutral-500 underline">Sign out</button>
        </form>
      </div>
      <p className="mt-1 text-sm text-neutral-500">{user?.email}</p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Views" value={(links ?? []).reduce((s, l) => s + (l.views ?? 0), 0)} />
        <Stat label="Sales" value={paid.length} />
        <Stat label="Downloads" value={(downloads ?? []).length} />
        <Stat label="Revenue" value={usd(revenueCents)} />
      </div>

      <h2 className="mt-10 text-lg font-semibold">Exchange links</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-2">Asset</th>
              <th className="py-2">Price</th>
              <th className="py-2">Views</th>
              <th className="py-2">Sales</th>
              <th className="py-2">Link</th>
            </tr>
          </thead>
          <tbody>
            {(links ?? []).map((l) => {
              const asset = l.asset as unknown as { title?: string } | null;
              return (
                <tr key={l.id} className="border-t border-neutral-200">
                  <td className="py-2">{asset?.title ?? '—'}</td>
                  <td className="py-2">{usd(l.price_cents)}</td>
                  <td className="py-2">{l.views}</td>
                  <td className="py-2">{salesByLink.get(l.id) ?? 0}</td>
                  <td className="py-2">
                    <Link href={`/x/${l.id}`} className="font-mono text-xs underline">
                      /x/{l.id.slice(0, 8)}…
                    </Link>
                  </td>
                </tr>
              );
            })}
            {(links ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-neutral-400">
                  No exchanges yet. <Link href="/upload" className="underline">Create one →</Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-lg font-semibold">Buyers</h2>
      {buyers.length ? (
        <ul className="mt-3 space-y-1 text-sm text-neutral-700">
          {buyers.map((b) => (
            <li key={b} className="font-mono">{b}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-neutral-400">No buyers yet.</p>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-neutral-200 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
