import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { getTrack } from '@/lib/server/tracks';
import { stripe, stripeConfigured } from '@/lib/server/stripe';
import { supabaseAdmin } from '@/lib/server/supabase';
import { purchases, type Purchase } from '@/lib/server/devstore';

export async function POST(request: NextRequest) {
  const data = await request.formData();
  const trackId = String(data.get('track_id') ?? '');
  const track = await getTrack(trackId);
  if (!track) return new NextResponse('Track not found', { status: 404 });

  const origin =
    process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;

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
      success_url: `${origin}/api/download?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/t/${track.id}`,
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
    return NextResponse.redirect(session.url!, { status: 303 });
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
  return NextResponse.redirect(`${origin}/api/download?purchase=${purchase.id}`, { status: 303 });
}
