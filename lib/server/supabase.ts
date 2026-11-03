import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _admin: SupabaseClient | null = null;

/**
 * Service-role client for trusted server-side writes (insert tracks,
 * mark purchases paid, log downloads). Never expose to the browser.
 * Returns null if env not configured yet, so the app still boots.
 */
export function supabaseAdmin(): SupabaseClient | null {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}
