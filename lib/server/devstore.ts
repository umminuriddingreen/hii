/**
 * In-memory fallback so the v1 spine runs end-to-end locally
 * BEFORE Supabase/R2/Stripe keys are filled in. Replaced by real
 * tables once env is configured. Data resets on server restart.
 *
 * Stashed on globalThis so Next.js dev hot-reload doesn't wipe it.
 */
export type Track = {
  id: string;
  title: string;
  price_cents: number;
  currency: string;
  license: string;
  r2_key: string;
  content_type: string;
  created_at: string;
};

export type Purchase = {
  id: string;
  track_id: string;
  status: 'pending' | 'paid' | 'failed';
  stripe_session_id: string;
  created_at: string;
  paid_at?: string;
};

export type DownloadEvent = {
  id: string;
  track_id: string;
  purchase_id?: string;
  created_at: string;
};

type Store = {
  tracks: Map<string, Track>;
  purchases: Map<string, Purchase>;
  downloads: DownloadEvent[];
};

const g = globalThis as unknown as { __hiiStore?: Store };
const store: Store =
  g.__hiiStore ?? (g.__hiiStore = { tracks: new Map(), purchases: new Map(), downloads: [] });

export const tracks = store.tracks;
export const purchases = store.purchases;
export const downloads = store.downloads;

export function downloadsForTrack(trackId: string): DownloadEvent[] {
  return downloads.filter((d) => d.track_id === trackId);
}
