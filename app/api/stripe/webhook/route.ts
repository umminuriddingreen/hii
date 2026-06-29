import { NextResponse, type NextRequest } from 'next/server';
import { stripe, stripeConfigured } from '@/lib/server/stripe';
import { supabaseAdmin } from '@/lib/server/supabase';

/**
 * Stripe webhook stub. On `checkout.session.completed` it marks the
 * matching purchase paid. Verifies the signature when the webhook
 * secret is present. The actual signed-download mint happens in
 * /api/download after this flips status to 'paid'.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) {
    return new NextResponse('stripe not configured', { status: 200 });
  }
  const s = stripe()!;
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = secret ? s.webhooks.constructEvent(body, sig, secret) : JSON.parse(body);
  } catch (err) {
    return new NextResponse(`webhook signature error: ${(err as Error).message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { id: string };
    const db = supabaseAdmin();
    if (db) {
      await db
        .from('purchases')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('stripe_session_id', session.id);
    }
  }

  return NextResponse.json({ received: true });
}
