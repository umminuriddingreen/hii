import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe, stripeConfigured } from '@/lib/server/support';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const supportLog = path.join(
  process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'),
  'support.jsonl'
);

async function recordSupport(entry: Record<string, unknown>) {
  await mkdir(path.dirname(supportLog), { recursive: true });
  await appendFile(supportLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * Stripe webhook for support/donations.
 *
 * The redirect back to /support/thanks is not proof of payment — the signed
 * webhook is. This records a receipt line and nothing else: it must not touch
 * the credit ledger (see lib/server/support.ts).
 */
export async function POST(request: Request) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'Stripe is not configured.' }, { status: 503 });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET is not set.' }, { status: 503 });
  }
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header.' }, { status: 400 });
  }

  // Raw body — constructEvent verifies against the exact bytes Stripe signed.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, secret);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Signature verification failed.' },
      { status: 400 }
    );
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.kind === 'hii_support') {
      await recordSupport({
        event: event.id,
        session: session.id,
        cadence: session.metadata.cadence ?? 'once',
        amountTotal: session.amount_total,
        currency: session.currency,
        livemode: event.livemode
      });
    }
  }

  return NextResponse.json({ received: true });
}
