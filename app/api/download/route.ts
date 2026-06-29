import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/server/supabase';
import { r2Configured, presignDownload } from '@/lib/server/r2';
import { stripe, stripeConfigured } from '@/lib/server/stripe';
import { getTrack } from '@/lib/server/tracks';
import { purchases, downloads, purchaseBySession, type DownloadEvent } from '@/lib/server/devstore';

/**
 * The core of the spine: only mint a signed download URL for a PAID
 * purchase, and write exactly one download_event each time.
 * ?session=<stripe_session_id>  (real Stripe path)
 * ?purchase=<purchase_id>       (dev fallback path)
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  const purchaseId = url.searchParams.get('purchase');

  const db = supabaseAdmin();
  let trackId: string | null = null;
  let purchaseRef: string | null = null;

  // Stripe path: trust the live session as source of truth for payment,
  // so a real test payment works without a webhook configured.
  if (sessionId && stripeConfigured()) {
    const s = stripe()!;
    const session = await s.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid')
      return new NextResponse('Payment not completed', { status: 402 });

    if (db) {
      await db
        .from('purchases')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('stripe_session_id', sessionId);
      const { data: purchase } = await db
        .from('purchases')
        .select('*')
        .eq('stripe_session_id', sessionId)
        .single();
      trackId = purchase?.track_id ?? (session.metadata?.track_id as string) ?? null;
      purchaseRef = purchase?.id ?? null;
    } else {
      const purchase = purchaseBySession(sessionId);
      if (purchase) {
        purchase.status = 'paid';
        purchase.paid_at = new Date().toISOString();
        purchaseRef = purchase.id;
        trackId = purchase.track_id;
      } else {
        trackId = (session.metadata?.track_id as string) ?? null;
      }
    }
    if (!trackId) return new NextResponse('Track not found', { status: 404 });
  } else if (db) {
    const q = db.from('purchases').select('*');
    const { data: purchase } = sessionId
      ? await q.eq('stripe_session_id', sessionId).single()
      : await q.eq('id', purchaseId ?? '').single();
    if (!purchase) return new NextResponse('Purchase not found', { status: 404 });
    if (purchase.status !== 'paid')
      return new NextResponse('Payment not completed', { status: 402 });
    trackId = purchase.track_id;
    purchaseRef = purchase.id;
  } else {
    const purchase = purchases.get(purchaseId ?? '');
    if (!purchase) return new NextResponse('Purchase not found', { status: 404 });
    if (purchase.status !== 'paid')
      return new NextResponse('Payment not completed', { status: 402 });
    trackId = purchase.track_id;
    purchaseRef = purchase.id;
  }

  const track = await getTrack(trackId!);
  if (!track) return new NextResponse('Track not found', { status: 404 });

  // Log the download event (one row per mint).
  if (db) {
    await db.from('download_events').insert({
      track_id: track.id,
      purchase_id: purchaseRef,
      user_agent: request.headers.get('user-agent')
    });
  } else {
    const ev: DownloadEvent = {
      id: randomUUID(),
      track_id: track.id,
      purchase_id: purchaseRef ?? undefined,
      created_at: new Date().toISOString()
    };
    downloads.push(ev);
  }

  // Real path: redirect to a short-lived signed R2 URL.
  if (r2Configured()) {
    const signed = await presignDownload(track.r2_key);
    return NextResponse.redirect(signed, { status: 303 });
  }

  // Dev fallback: no real bytes — confirm the path worked.
  return new NextResponse(
    `Payment confirmed. In production this would redirect to a 5-min signed R2 URL for:\n  ${track.r2_key}\nDownload logged for track ${track.id}.`,
    { status: 200, headers: { 'content-type': 'text/plain' } }
  );
}
