import { redirect, type Handle } from '@sveltejs/kit';
import { requestContext } from '$lib/request-context';
import { remoteSessionCookie, verifyRemoteSession } from '$lib/server/hii-remote-auth';

const cloudflareLaunchRoutes = new Set([
  '/',
  '/landing',
  '/learn',
  '/activate',
  '/architecture',
  '/pilot',
  '/privacy',
  '/remote',
  '/remote/login',
  '/remote/logout'
]);

export const handle: Handle = async ({ event, resolve }) => {
  if (
    __HII_DEPLOY_TARGET__ === 'cloudflare' &&
    !cloudflareLaunchRoutes.has(event.url.pathname)
  ) {
    return new Response('Not found', { status: 404 });
  }

  if (event.url.pathname === '/remote') {
    const env = event.platform?.env;
    const username = env?.HII_REMOTE_USER;
    const sessionKey = env?.HII_REMOTE_SESSION_KEY;
    if (!username || !sessionKey) {
      return new Response('Remote workspace is not configured.', { status: 503 });
    }
    const valid = await verifyRemoteSession(
      event.cookies.get(remoteSessionCookie),
      username,
      sessionKey
    );
    if (!valid) throw redirect(303, '/remote/login');
  }

  return requestContext.run({ cookies: event.cookies }, () => resolve(event));
};
