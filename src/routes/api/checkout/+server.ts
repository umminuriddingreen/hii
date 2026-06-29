import { redirect } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import type { RequestHandler } from './$types';
import { getTrack } from '$lib/server/tracks';
import { stripe, stripeConfigured } from '$lib/server/stripe';
import { supabaseAdmin } from '$lib/server/supabase';
import { purchases, type Purchase } from '$lib/server/devstore';

export const POST: RequestHandler = async ({ request, url }) => {
  const data = await request.formData();
  const trackId = String(data.get('track_id') ?? '');
  const track = await getTrack(trackId);
  if (!track) return new Response('Track not found', { status: 404 });

  // Real path: hand off to Stripe Checkout.
  if (stripeConfigured()) {
    const s = stripe()!;
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: track.currency,
            unit_amount: track.price_cents,
            product_data: { name: track.title }
          }
        }
      ],
      success_url: `${url.origin}/api/download?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${url.origin}/t/${track.id}`,
      metadata: { track_id: track.id }
    });

    const db = supabaseAdmin();
    if (db) {
      await db.from('purchases').insert({
        track_id: track.id,
        amount_cents: track.price_cents,
        currency: track.currency,
        stripe_session_id: session.id,
        status: 'pending'
      });
    }
    throw redirect(303, session.url!);
  }

  // Dev fallback: simulate an instant successful payment so the spine runs.
  const purchase: Purchase = {
    id: randomUUID(),
    track_id: track.id,
    status: 'paid',
    stripe_session_id: `dev_${randomUUID()}`,
    created_at: new Date().toISOString(),
    paid_at: new Date().toISOString()
  };
  purchases.set(purchase.id, purchase);
  throw redirect(303, `/api/download?purchase=${purchase.id}`);
};
