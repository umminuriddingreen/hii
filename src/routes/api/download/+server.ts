import { redirect, error } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import type { RequestHandler } from './$types';
import { supabaseAdmin } from '$lib/server/supabase';
import { r2Configured, presignDownload } from '$lib/server/r2';
import { getTrack } from '$lib/server/tracks';
import { purchases, downloads, type DownloadEvent } from '$lib/server/devstore';

/**
 * The core of the spine: only mint a signed download URL for a PAID
 * purchase, and write exactly one download_event each time.
 * ?session=<stripe_session_id>  (real Stripe path)
 * ?purchase=<purchase_id>       (dev fallback path)
 */
export const GET: RequestHandler = async ({ url, request }) => {
  const sessionId = url.searchParams.get('session');
  const purchaseId = url.searchParams.get('purchase');

  const db = supabaseAdmin();
  let trackId: string | null = null;
  let purchaseRef: string | null = null;

  if (db) {
    const q = db.from('purchases').select('*');
    const { data: purchase } = sessionId
      ? await q.eq('stripe_session_id', sessionId).single()
      : await q.eq('id', purchaseId ?? '').single();
    if (!purchase) throw error(404, 'Purchase not found');
    if (purchase.status !== 'paid') throw error(402, 'Payment not completed');
    trackId = purchase.track_id;
    purchaseRef = purchase.id;
  } else {
    const purchase = purchases.get(purchaseId ?? '');
    if (!purchase) throw error(404, 'Purchase not found');
    if (purchase.status !== 'paid') throw error(402, 'Payment not completed');
    trackId = purchase.track_id;
    purchaseRef = purchase.id;
  }

  const track = await getTrack(trackId!);
  if (!track) throw error(404, 'Track not found');

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
    throw redirect(303, signed);
  }

  // Dev fallback: no real bytes — confirm the path worked.
  return new Response(
    `Payment confirmed. In production this would redirect to a 5-min signed R2 URL for:\n  ${track.r2_key}\nDownload logged for track ${track.id}.`,
    { status: 200, headers: { 'content-type': 'text/plain' } }
  );
};
