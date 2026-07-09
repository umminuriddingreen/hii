'use server';

import { randomUUID } from 'crypto';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { uploadObject, r2Configured } from '@/lib/server/r2';

export type UploadState = { error?: string; linkUrl?: string };

/**
 * Creates the full exchange primitive from one form: an asset (file in R2),
 * a license (terms), and an exchange link (price) — all owned by the
 * signed-in seller. Returns the shareable /x/[id] link.
 */
export async function createExchange(
  _prev: UploadState,
  data: FormData
): Promise<UploadState> {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return { error: 'You must be signed in to create an exchange.' };

  const title = String(data.get('title') ?? '').trim();
  const description = String(data.get('description') ?? '').trim() || null;
  const priceDollars = Number(data.get('price'));
  const licenseName = String(data.get('license_name') ?? '').trim() || 'Standard';
  const exclusivity = String(data.get('exclusivity') ?? 'non-exclusive');
  const terms = String(data.get('terms') ?? '').trim();
  const file = data.get('file');

  if (!title) return { error: 'Title is required.' };
  if (!Number.isFinite(priceDollars) || priceDollars < 0) return { error: 'Invalid price.' };
  if (!(file instanceof File) || file.size === 0) return { error: 'A file is required.' };
  if (!r2Configured()) return { error: 'Storage is not configured.' };

  const assetId = randomUUID();
  const r2Key = `assets/${assetId}/${file.name}`;
  const contentType = file.type || 'application/octet-stream';

  // TRANSFER target first: bytes into R2.
  try {
    await uploadObject(r2Key, new Uint8Array(await file.arrayBuffer()), contentType);
  } catch {
    return { error: 'Upload to storage failed.' };
  }

  // TERMS
  const { data: license, error: licErr } = await supabase
    .from('licenses')
    .insert({ seller_id: user.id, name: licenseName, terms, exclusivity })
    .select('id')
    .single();
  if (licErr) return { error: licErr.message };

  // WHAT
  const { error: assetErr } = await supabase.from('assets').insert({
    id: assetId,
    seller_id: user.id,
    title,
    description,
    r2_key: r2Key,
    content_type: contentType,
    file_size: file.size
  });
  if (assetErr) return { error: assetErr.message };

  // VALUE — the shareable exchange link
  const { data: link, error: linkErr } = await supabase
    .from('exchange_links')
    .insert({
      seller_id: user.id,
      asset_id: assetId,
      license_id: license.id,
      price_cents: Math.round(priceDollars * 100)
    })
    .select('id')
    .single();
  if (linkErr) return { error: linkErr.message };

  const h = headers();
  const origin =
    process.env.NEXT_PUBLIC_BASE_URL ??
    `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  return { linkUrl: `${origin}/x/${link.id}` };
}
