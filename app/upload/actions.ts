'use server';

import { randomUUID } from 'crypto';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/server/supabase';
import { r2Configured, uploadObject } from '@/lib/server/r2';
import { tracks, type Track } from '@/lib/server/devstore';

export type UploadState = { error?: string; assetUrl?: string };

export async function createTrack(
  _prev: UploadState,
  data: FormData
): Promise<UploadState> {
  const title = String(data.get('title') ?? '').trim();
  const priceDollars = Number(data.get('price'));
  const license = String(data.get('license') ?? 'non-exclusive');
  const file = data.get('file');

  if (!title) return { error: 'Title is required.' };
  if (!Number.isFinite(priceDollars) || priceDollars < 0) return { error: 'Invalid price.' };
  if (!(file instanceof File) || file.size === 0) return { error: 'Audio file is required.' };

  const id = randomUUID();
  const r2Key = `tracks/${id}/${file.name}`;
  const contentType = file.type || 'audio/mpeg';
  const price_cents = Math.round(priceDollars * 100);

  const db = supabaseAdmin();

  if (db && r2Configured()) {
    // Real path: upload bytes to R2, insert row.
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await uploadObject(r2Key, bytes, contentType);
    } catch {
      return { error: 'Upload to storage failed.' };
    }
    const { error } = await db.from('tracks').insert({
      id,
      title,
      price_cents,
      license,
      r2_key: r2Key,
      content_type: contentType
    });
    if (error) return { error: error.message };
  } else {
    // Dev fallback: keep it in memory so the spine runs without keys.
    const track: Track = {
      id,
      title,
      price_cents,
      currency: 'usd',
      license,
      r2_key: r2Key,
      content_type: contentType,
      created_at: new Date().toISOString()
    };
    tracks.set(id, track);
  }

  const h = headers();
  const origin =
    process.env.NEXT_PUBLIC_BASE_URL ??
    `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  return { assetUrl: `${origin}/t/${id}` };
}
