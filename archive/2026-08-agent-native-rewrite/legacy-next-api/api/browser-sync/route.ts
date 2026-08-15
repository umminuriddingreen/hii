import { mergeBrowserSync, readBrowserSync } from '@/lib/server/hii-browser-sync';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status });
const local = (request: Request) => ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname);

function secret(request: Request) {
  return request.headers.get('x-hii-sync-key') || '';
}

export async function GET(request: Request) {
  if (!local(request)) return json({ error: 'HII browser sync is local-only.' }, 403);
  try {
    return json(await readBrowserSync(secret(request)));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not read browser sync.' }, 400);
  }
}

export async function POST(request: Request) {
  if (!local(request)) return json({ error: 'HII browser sync is local-only.' }, 403);
  try {
    const body = await request.json() as { collections?: Record<string, unknown[]> };
    return json(await mergeBrowserSync(secret(request), body.collections || {}));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not update browser sync.' }, 400);
  }
}
