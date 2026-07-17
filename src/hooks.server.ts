import type { Handle } from '@sveltejs/kit';
import { requestContext } from '$lib/request-context';

export const handle: Handle = async ({ event, resolve }) =>
  requestContext.run({ cookies: event.cookies }, () => resolve(event));
