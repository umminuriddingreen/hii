import { createBrowserClient } from '@supabase/ssr';

/** Browser Supabase client (used for magic-link sign-in / sign-out). */
export function createClient() {
  const env = import.meta.env as Record<string, string | undefined>;
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
