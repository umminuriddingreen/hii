import installer from '../../../scripts/install.sh?raw';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  new Response(installer, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff'
    }
  });
