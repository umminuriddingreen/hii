import type { RequestHandler } from './$types';
import * as callback from '@/app/(app)/auth/callback/route';
import * as signout from '@/app/(app)/auth/signout/route';

const dispatch = (method: 'GET' | 'POST'): RequestHandler => async (event) => {
  const module = event.params.path === 'callback' ? callback : event.params.path === 'signout' ? signout : null;
  if (!module) return new Response('Not Found', { status: 404 });
  const handler = (module as unknown as Record<string, ((request: Request) => Response | Promise<Response>) | undefined>)[method];
  if (!handler) return new Response('Method Not Allowed', { status: 405 });
  return handler(event.request as never);
};

export const GET = dispatch('GET');
export const POST = dispatch('POST');
