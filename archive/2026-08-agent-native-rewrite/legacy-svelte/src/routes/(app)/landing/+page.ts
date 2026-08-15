import { redirect } from '@sveltejs/kit';

export const load = () => {
  if (__HII_TARGET__ === 'web') redirect(308, '/');
};
