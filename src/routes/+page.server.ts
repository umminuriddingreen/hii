import { redirect } from '@sveltejs/kit';
import { readHiiConfig } from '@/lib/server/hii-config';

export const load = () => {
  const config = readHiiConfig();
  const homepage = config.defaults.homepage || 'workspace';
  if (homepage !== 'workspace') redirect(307, `/${homepage}`);
  return { enabled: config.surfaces.workspace?.enabled !== false };
};
