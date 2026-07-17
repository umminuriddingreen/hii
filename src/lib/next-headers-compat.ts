import { requestContext } from './request-context';

export function cookies() {
  const store = requestContext.getStore();
  if (!store) throw new Error('Cookie access requires an active SvelteKit request.');
  return {
    getAll: () => store.cookies.getAll(),
    set: (name: string, value: string, options: Record<string, unknown> = {}) =>
      store.cookies.set(name, value, { path: '/', ...options })
  };
}
