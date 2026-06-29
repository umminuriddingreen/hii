import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { stripe, stripeConfigured } from '$lib/server/stripe';
import { supabaseAdmin } from '$lib/server/supabase';

/**
 * Stripe webhook stub. On `checkout.session.completed` it marks the
 * matching purchase paid. Verifies the signature when the webhook
 * secret is present. The actual signed-download mint happens in
 * /api/download after this flips status to 'paid'.
 */
export const POST: RequestHandler = async ({ request }) => {
  if (!stripeConfigured()) {
    return new Response('stripe not configured', { status: 200 });
  }
  const s = stripe()!;
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';
  const secret = env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = secret
      ? s.webhooks.constructEvent(body, sig, secret)
      : JSON.parse(body);
  } catch (err) {
    return new Response(`webhook signature error: ${(err as Error).message}`, {
      status: 400
    });
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

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};
