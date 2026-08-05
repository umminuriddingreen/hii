import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  createRemoteSession,
  remoteSessionCookie,
  remoteSessionMaxAge,
  timingSafeTextEqual
} from '$lib/server/hii-remote-auth';

export const load: PageServerLoad = async ({ platform }) => ({
  configured: Boolean(
    platform?.env?.HII_REMOTE_USER &&
      platform.env.HII_REMOTE_PASSWORD &&
      platform.env.HII_REMOTE_SESSION_KEY
  )
});

export const actions: Actions = {
  default: async ({ request, platform, cookies }) => {
    const env = platform?.env;
    const expectedUsername = env?.HII_REMOTE_USER;
    const expectedPassword = env?.HII_REMOTE_PASSWORD;
    const sessionKey = env?.HII_REMOTE_SESSION_KEY;
    if (!expectedUsername || !expectedPassword || !sessionKey) {
      return fail(503, { error: 'Remote workspace is not configured.' });
    }

    const data = await request.formData();
    const username = String(data.get('username') || '');
    const password = String(data.get('password') || '');
    const [validUsername, validPassword] = await Promise.all([
      timingSafeTextEqual(username, expectedUsername),
      timingSafeTextEqual(password, expectedPassword)
    ]);
    if (!validUsername || !validPassword) {
      return fail(400, { error: 'That login did not match.' });
    }

    cookies.set(remoteSessionCookie, await createRemoteSession(expectedUsername, sessionKey), {
      path: '/remote',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: remoteSessionMaxAge
    });
    throw redirect(303, '/remote');
  }
};
