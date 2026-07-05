import { NextResponse, type NextRequest } from 'next/server';
import { stripe, stripeConfigured } from '@/lib/server/stripe';
import { markOrderPaid } from '@/lib/server/data';
import { applyCreditTopUp, parseCreditCurrency } from '@/lib/server/credits';

/**
 * Marks an order paid on checkout.session.completed. The /api/download
 * route also re-verifies payment against Stripe, so this is the durable
 * backstop (e.g. buyer closes the tab before redirect).
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) return new NextResponse('stripe not configured', { status: 200 });
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
    const session = event.data.object as {
      id: string;
      amount_total?: number | null;
      customer_details?: { email?: string | null } | null;
      metadata?: Record<string, string> | null;
    };
    if (session.metadata?.kind === 'credit_topup') {
      const userId = session.metadata.user_id;
      const currency = parseCreditCurrency(session.metadata.currency);
      const amountCents = Number(session.metadata.amount_cents ?? session.amount_total ?? 0);
      if (userId && Number.isFinite(amountCents) && amountCents > 0) {
        await applyCreditTopUp({
          userId,
          currency,
          amountCents: Math.round(amountCents),
          stripeSessionId: session.id
        });
      }
    } else {
      await markOrderPaid(session.id, session.customer_details?.email ?? null);
    }
  }

  return NextResponse.json({ received: true });
}
