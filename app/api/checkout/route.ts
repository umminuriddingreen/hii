import { NextResponse, type NextRequest } from 'next/server';
import { getExchangeLink, createPendingOrder } from '@/lib/server/data';
import { stripe, stripeConfigured } from '@/lib/server/stripe';

/**
 * Step 3: start a Stripe Checkout for an exchange link. Records a pending
 * order and stamps the full exchange context into the session metadata.
 */
export async function POST(request: NextRequest) {
  const data = await request.formData();
  const linkId = String(data.get('link_id') ?? '');
  const link = await getExchangeLink(linkId);
  if (!link) return new NextResponse('Exchange link not found', { status: 404 });
  if (!stripeConfigured()) return new NextResponse('Payments not configured', { status: 503 });

  const origin = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const s = stripe()!;

  const session = await s.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: link.currency,
          unit_amount: link.price_cents,
          product_data: {
            name: link.asset.title,
            description: link.license ? `${link.license.name} (${link.license.exclusivity})` : undefined
          }
        }
      }
    ],
    success_url: `${origin}/api/download?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/x/${link.id}`,
    metadata: {
      asset_id: link.asset_id,
      seller_id: link.seller_id,
      license_id: link.license_id ?? '',
      exchange_link_id: link.id
    }
  });

  await createPendingOrder(link, session.id);
  return NextResponse.redirect(session.url!, { status: 303 });
}
