// SPDX-License-Identifier: LicenseRef-BSL-1.1
/**
 * Support / donations.
 *
 * Deliberately NOT part of the credit ledger (`lib/server/credits.ts`).
 * A donation is a gift toward HII's development — it must never mint spendable
 * balance, reserve a capability job, or appear as a credit top-up. If you ever
 * find yourself importing `applyCreditTopUp` here, stop: that is a purchase,
 * and purchases belong in the credits path.
 */
import Stripe from 'stripe';

export type SupportCadence = 'once' | 'monthly';

/** Preset amounts in whole USD. Understated on purpose — no tiers, no perks. */
export const supportAmounts = [5, 25, 100] as const;

export const supportMinAmount = 1;
export const supportMaxAmount = 5000;

export const githubSponsorsUrl = 'https://github.com/sponsors/umminuriddingreen';

export function parseSupportCadence(value: unknown): SupportCadence {
  return value === 'monthly' ? 'monthly' : 'once';
}

/**
 * Whole dollars in, cents out. Rejects anything that is not a finite number in
 * range so a hand-rolled POST cannot open a $0 or $1,000,000 session.
 */
export function parseSupportAmountCents(value: unknown): number {
  const dollars = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(dollars)) {
    throw new Error('Choose an amount to support HII.');
  }
  const rounded = Math.round(dollars);
  if (rounded < supportMinAmount || rounded > supportMaxAmount) {
    throw new Error(`Support amounts run from $${supportMinAmount} to $${supportMaxAmount}.`);
  }
  return rounded * 100;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to accept support.');
  }
  return new Stripe(key);
}

export function baseUrl(request?: Request): string {
  const configured = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  if (request) return new URL(request.url).origin;
  return 'http://localhost:3000';
}

export async function createSupportCheckoutSession(args: {
  amountCents: number;
  cadence: SupportCadence;
  origin: string;
}): Promise<{ url: string; id: string; livemode: boolean }> {
  const stripe = getStripe();
  const productName = args.cadence === 'monthly' ? 'Monthly support for HII' : 'Support for HII';

  const session = await stripe.checkout.sessions.create({
    mode: args.cadence === 'monthly' ? 'subscription' : 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: args.amountCents,
          product_data: {
            name: productName,
            description:
              'A voluntary contribution toward the development of HII. Not a purchase; no goods or services are provided in return.'
          },
          ...(args.cadence === 'monthly' ? { recurring: { interval: 'month' as const } } : {})
        }
      }
    ],
    submit_type: args.cadence === 'monthly' ? undefined : 'donate',
    success_url: `${args.origin}/support/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${args.origin}/support`,
    metadata: { kind: 'hii_support', cadence: args.cadence }
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL.');
  }
  return { url: session.url, id: session.id, livemode: session.livemode };
}
