import 'server-only';
import { createHash } from 'crypto';
import { supabaseAdmin } from './supabase';

/**
 * Service-role data access for the buyer + payment flows (exchange links,
 * orders, download proof). These run server-side and intentionally bypass
 * RLS — the public exchange page and Stripe webhooks have no user session.
 * Seller-owned reads/writes go through the RLS-bound client in lib/supabase/server.
 */

export type Asset = {
  id: string;
  seller_id: string;
  title: string;
  description: string | null;
  r2_key: string;
  preview_key: string | null;
  content_type: string;
  file_size: number | null;
  created_at: string;
};

export type License = {
  id: string;
  seller_id: string;
  name: string;
  terms: string;
  exclusivity: string;
};

export type ExchangeLink = {
  id: string;
  seller_id: string;
  asset_id: string;
  license_id: string | null;
  price_cents: number;
  currency: string;
  active: boolean;
  views: number;
  created_at: string;
};

/** An exchange link joined with its asset, license and seller — what /x/[id] shows. */
export type ExchangeLinkFull = ExchangeLink & {
  asset: Asset;
  license: License | null;
  seller_name: string | null;
};

export type FeedItem = ExchangeLinkFull & {
  seller_handle: string | null;
};

function db() {
  const client = supabaseAdmin();
  if (!client) throw new Error('Supabase service role not configured');
  return client;
}

export async function getExchangeLink(id: string): Promise<ExchangeLinkFull | null> {
  const { data } = await db()
    .from('exchange_links')
    .select('*, asset:assets(*), license:licenses(*)')
    .eq('id', id)
    .eq('active', true)
    .single();
  if (!data || !data.asset) return null;

  const { data: profile } = await db()
    .from('profiles')
    .select('display_name')
    .eq('id', data.seller_id)
    .single();

  return { ...(data as ExchangeLinkFull), seller_name: profile?.display_name ?? null };
}

export async function getPublicFeed(): Promise<FeedItem[]> {
  const { data } = await db()
    .from('exchange_links')
    .select('*, asset:assets(*), license:licenses(*)')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(48);

  const links = (data ?? []).filter((item) => item.asset) as ExchangeLinkFull[];
  const sellerIds = Array.from(new Set(links.map((link) => link.seller_id)));
  const { data: profiles } = sellerIds.length
    ? await db().from('profiles').select('id, display_name').in('id', sellerIds)
    : { data: [] };

  const profileById = new Map(
    (profiles ?? []).map((profile) => [
      profile.id as string,
      {
        displayName: (profile.display_name as string | null) ?? null,
        handle: null
      }
    ])
  );

  return links.map((link) => {
    const profile = profileById.get(link.seller_id);
    return {
      ...link,
      seller_name: profile?.displayName ?? null,
      seller_handle: profile?.handle ?? null
    };
  });
}

/** Best-effort view counter for analytics; never blocks the page. */
export async function incrementLinkViews(id: string): Promise<void> {
  await db().rpc('increment_link_views', { link_id: id });
}

export async function createPendingOrder(
  link: ExchangeLinkFull,
  stripeSessionId: string
): Promise<void> {
  await db().from('orders').insert({
    exchange_link_id: link.id,
    asset_id: link.asset_id,
    seller_id: link.seller_id,
    license_id: link.license_id,
    amount_cents: link.price_cents,
    currency: link.currency,
    stripe_session_id: stripeSessionId,
    status: 'pending'
  });
}

export async function markOrderPaid(stripeSessionId: string, buyerEmail?: string | null) {
  const patch: Record<string, unknown> = { status: 'paid', paid_at: new Date().toISOString() };
  if (buyerEmail) patch.buyer_email = buyerEmail;
  await db().from('orders').update(patch).eq('stripe_session_id', stripeSessionId);
}

export async function getOrderBySession(stripeSessionId: string) {
  const { data } = await db()
    .from('orders')
    .select('*')
    .eq('stripe_session_id', stripeSessionId)
    .single();
  return data;
}

export async function getOrderById(id: string) {
  const { data } = await db().from('orders').select('*').eq('id', id).single();
  return data;
}

export async function getAsset(id: string): Promise<Asset | null> {
  const { data } = await db().from('assets').select('*').eq('id', id).single();
  return (data as Asset) ?? null;
}

/** PROOF: write one download_event per signed-URL mint. */
export async function logDownload(args: {
  order_id: string | null;
  asset_id: string;
  buyer_email?: string | null;
  ip?: string | null;
  user_agent?: string | null;
}): Promise<void> {
  await db().from('download_events').insert({
    order_id: args.order_id,
    asset_id: args.asset_id,
    buyer_email: args.buyer_email ?? null,
    ip_hash: args.ip ? createHash('sha256').update(args.ip).digest('hex').slice(0, 32) : null,
    user_agent: args.user_agent ?? null
  });
}
