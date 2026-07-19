import type { PageServerLoad } from './$types';

type AuthSettings = {
  external?: {
    google?: boolean;
    apple?: boolean;
  };
};

export const load: PageServerLoad = async ({ fetch }) => {
  const publicEnv = import.meta.env as Record<string, string | undefined>;
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return { providers: { google: false, apple: false } };

  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, {
      headers: { apikey: key }
    });
    if (!response.ok) return { providers: { google: false, apple: false } };

    const settings = await response.json() as AuthSettings;
    return {
      providers: {
        google: settings.external?.google === true,
        apple: settings.external?.apple === true
      }
    };
  } catch {
    return { providers: { google: false, apple: false } };
  }
};
