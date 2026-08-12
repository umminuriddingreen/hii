import installer from '../../../scripts/install.sh?raw';
import type { RequestHandler } from './$types';

const headers = {
  'content-type': 'text/x-shellscript; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff'
};

export const GET: RequestHandler = () =>
  new Response(installer, {
    headers
  });

export const HEAD: RequestHandler = () => new Response(null, { headers });
