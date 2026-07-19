import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { safeNextPath } from '@/lib/auth/redirect';
import { createClient } from '@/lib/supabase/server';

export const GET: RequestHandler = async ({ params, url }) => {
  if (params.path !== 'callback') return new Response('Not Found', { status: 404 });

  const code = url.searchParams.get('code');
  const next = safeNextPath(url.searchParams.get('next'));
  if (code) {
    const { error } = await createClient().auth.exchangeCodeForSession(code);
    if (!error) redirect(303, next);
  }

  redirect(303, '/login?error=auth');
};

export const POST: RequestHandler = async ({ params }) => {
  if (params.path !== 'signout') return new Response('Not Found', { status: 404 });
  await createClient().auth.signOut();
  redirect(303, '/');
};
