import type { Handle } from '@sveltejs/kit';
import { requestContext } from '$lib/request-context';

const cloudflareLaunchRoutes = new Set([
  '/',
  '/landing',
  '/learn',
  '/activate',
  '/pilot',
  '/privacy'
]);

export const handle: Handle = async ({ event, resolve }) => {
  if (
    __HII_DEPLOY_TARGET__ === 'cloudflare' &&
    !cloudflareLaunchRoutes.has(event.url.pathname)
  ) {
    return new Response('Not found', { status: 404 });
  }

  return requestContext.run({ cookies: event.cookies }, () => resolve(event));
};
