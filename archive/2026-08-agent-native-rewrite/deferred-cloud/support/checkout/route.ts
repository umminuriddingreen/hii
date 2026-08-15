import { NextResponse } from 'next/server';
import {
  baseUrl,
  createSupportCheckoutSession,
  parseSupportAmountCents,
  parseSupportCadence,
  stripeConfigured
} from '@/lib/server/support';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: 'Stripe is not configured on this instance. Use GitHub Sponsors instead.' },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    amount?: unknown;
    cadence?: unknown;
  } | null;

  try {
    const session = await createSupportCheckoutSession({
      amountCents: parseSupportAmountCents(body?.amount),
      cadence: parseSupportCadence(body?.cadence),
      origin: baseUrl(request)
    });
    return NextResponse.json({ url: session.url, livemode: session.livemode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not start a support checkout.' },
      { status: 400 }
    );
  }
}
