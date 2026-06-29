import { NextResponse, type NextRequest } from 'next/server';
import {
  getAsset,
  getOrderBySession,
  getOrderById,
  markOrderPaid,
  logDownload
} from '@/lib/server/data';
import { r2Configured, presignDownload } from '@/lib/server/r2';
import { stripe, stripeConfigured } from '@/lib/server/stripe';

/**
 * Steps 4 & 5: only a PAID order yields access. Mint a short-lived signed
 * R2 URL (the raw object is never exposed permanently) and log one
 * download_event as proof.
 *   ?session=<stripe_session_id>  → after Stripe Checkout returns
 *   ?order=<order_id>             → re-download of an already-paid order
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  const orderId = url.searchParams.get('order');

  let order: Awaited<ReturnType<typeof getOrderBySession>> | null = null;
  let buyerEmail: string | null = null;

  if (sessionId && stripeConfigured()) {
    // Trust the live Stripe session as source of truth for payment.
    const s = stripe()!;
    const session = await s.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid')
      return new NextResponse('Payment not completed', { status: 402 });
    buyerEmail = session.customer_details?.email ?? null;
    await markOrderPaid(sessionId, buyerEmail);
    order = await getOrderBySession(sessionId);
  } else if (orderId) {
    order = await getOrderById(orderId);
  }

  if (!order) return new NextResponse('Order not found', { status: 404 });
  if (order.status !== 'paid') return new NextResponse('Payment not completed', { status: 402 });

  const asset = await getAsset(order.asset_id);
  if (!asset) return new NextResponse('Asset not found', { status: 404 });

  await logDownload({
    order_id: order.id,
    asset_id: asset.id,
    buyer_email: buyerEmail ?? order.buyer_email,
    ip: request.headers.get('x-forwarded-for'),
    user_agent: request.headers.get('user-agent')
  });

  if (!r2Configured()) return new NextResponse('Storage not configured', { status: 503 });
  const signed = await presignDownload(asset.r2_key);
  return NextResponse.redirect(signed, { status: 303 });
}
