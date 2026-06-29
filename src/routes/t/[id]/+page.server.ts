import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTrack, getDownloadCount } from '$lib/server/tracks';

export const load: PageServerLoad = async ({ params }) => {
  const track = await getTrack(params.id);
  if (!track) throw error(404, 'Track not found');

  return {
    track: {
      id: track.id,
      title: track.title,
      price_cents: track.price_cents,
      currency: track.currency,
      license: track.license
    },
    downloadCount: await getDownloadCount(track.id)
  };
};
