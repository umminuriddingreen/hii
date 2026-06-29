import { supabaseAdmin } from '$lib/server/supabase';
import {
  tracks as devTracks,
  downloadsForTrack,
  type Track
} from '$lib/server/devstore';

/** Fetch a track from Supabase if configured, else the dev store. */
export async function getTrack(id: string): Promise<Track | null> {
  const db = supabaseAdmin();
  if (db) {
    const { data } = await db.from('tracks').select('*').eq('id', id).single();
    return (data as Track) ?? null;
  }
  return devTracks.get(id) ?? null;
}

/** Count download events for a track (for the producer log). */
export async function getDownloadCount(id: string): Promise<number> {
  const db = supabaseAdmin();
  if (db) {
    const { count } = await db
      .from('download_events')
      .select('*', { count: 'exact', head: true })
      .eq('track_id', id);
    return count ?? 0;
  }
  return downloadsForTrack(id).length;
}
