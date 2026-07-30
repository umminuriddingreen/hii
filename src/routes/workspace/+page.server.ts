import { readHiiConfig } from '@/lib/server/hii-config';

export const load = () => {
  const config = readHiiConfig();
  return { enabled: config.surfaces.workspace?.enabled !== false };
};
