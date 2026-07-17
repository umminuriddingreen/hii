import { AsyncLocalStorage } from 'node:async_hooks';
import type { Cookies } from '@sveltejs/kit';

export const requestContext = new AsyncLocalStorage<{ cookies: Cookies }>();
