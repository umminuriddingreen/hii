/**
 * In-memory fallback so the v1 spine runs end-to-end locally
 * BEFORE Supabase/R2/Stripe keys are filled in. Replaced by real
 * tables once env is configured. Data resets on server restart.
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

export const tracks = new Map<string, Track>();
export const purchases = new Map<string, Purchase>();
export const downloads: DownloadEvent[] = [];

export function downloadsForTrack(trackId: string): DownloadEvent[] {
  return downloads.filter((d) => d.track_id === trackId);
}
