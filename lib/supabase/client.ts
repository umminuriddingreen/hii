'use client';
import { createBrowserClient } from '@supabase/ssr';

/** Browser Supabase client (used for magic-link sign-in / sign-out). */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
