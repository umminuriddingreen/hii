import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { remoteSessionCookie } from '$lib/server/hii-remote-auth';

export const POST: RequestHandler = ({ cookies }) => {
  cookies.delete(remoteSessionCookie, { path: '/remote' });
  throw redirect(303, '/remote/login');
};
