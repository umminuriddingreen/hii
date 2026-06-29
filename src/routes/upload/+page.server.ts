import { fail } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import type { Actions } from './$types';
import { supabaseAdmin } from '$lib/server/supabase';
import { r2Configured, presignUpload } from '$lib/server/r2';
import { tracks, type Track } from '$lib/server/devstore';

export const actions: Actions = {
  default: async ({ request, url }) => {
    const data = await request.formData();
    const title = String(data.get('title') ?? '').trim();
    const priceDollars = Number(data.get('price'));
    const license = String(data.get('license') ?? 'non-exclusive');
    const file = data.get('file');

    if (!title) return fail(400, { error: 'Title is required.' });
    if (!Number.isFinite(priceDollars) || priceDollars < 0)
      return fail(400, { error: 'Invalid price.' });
    if (!(file instanceof File) || file.size === 0)
      return fail(400, { error: 'Audio file is required.' });

    const id = randomUUID();
    const r2Key = `tracks/${id}/${file.name}`;
    const contentType = file.type || 'audio/mpeg';
    const price_cents = Math.round(priceDollars * 100);

    const db = supabaseAdmin();

    if (db && r2Configured()) {
      // Real path: upload bytes to R2, insert row.
      const putUrl = await presignUpload(r2Key, contentType);
      const put = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: await file.arrayBuffer()
      });
      if (!put.ok) return fail(502, { error: 'Upload to storage failed.' });

      const { error } = await db.from('tracks').insert({
        id,
        title,
        price_cents,
        license,
        r2_key: r2Key,
        content_type: contentType
      });
      if (error) return fail(500, { error: error.message });
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

    return { assetUrl: `${url.origin}/t/${id}` };
  }
};
