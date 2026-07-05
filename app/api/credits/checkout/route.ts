import { NextResponse } from 'next/server';
import {
  parseCreditCurrency,
  stripeTopUpCurrencies,
  type CreditCurrency
} from '@/lib/server/credits';
import { stripe, stripeConfigured } from '@/lib/server/stripe';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const topUpAmounts = new Set([1000, 2500, 5000, 10000, 25000]);

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'Payments are not configured.' }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const currency = parseCreditCurrency(body?.currency);
  const amountCents =
    typeof body?.amountCents === 'number' && Number.isFinite(body.amountCents)
      ? Math.round(body.amountCents)
      : 0;

  if (!stripeTopUpCurrencies.includes(currency as CreditCurrency)) {
    return NextResponse.json(
      { error: 'Stripe top-ups require USD, EUR, or GBP.' },
      { status: 400 }
    );
  }
  if (!topUpAmounts.has(amountCents)) {
    return NextResponse.json({ error: 'Choose a supported top-up amount.' }, { status: 400 });
  }

  const origin = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const s = stripe()!;
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: 'HII task credits',
            description: 'Prepaid balance for quoted HII capability jobs.'
          }
        }
      }
    ],
    success_url: `${origin}/credits?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/credits?topup=cancelled`,
    metadata: {
      kind: 'credit_topup',
      user_id: user.id,
      currency,
      amount_cents: String(amountCents)
    }
  });

  return NextResponse.json({ url: session.url });
}
