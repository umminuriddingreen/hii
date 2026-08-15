import { chromiumSession, closeChromiumSession, type BrowserCommand } from '../../../../lib/server/hii-chromium';

const local = (request: Request) => ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname);
const json = (value: unknown, status = 200) => Response.json(value, { status });

export async function POST(request: Request) {
  if (!local(request)) return json({ error: 'HII Chromium is local-only' }, 403);
  try {
    const body = await request.json() as { id?: string; command?: BrowserCommand };
    if (!body.id || !body.command) return json({ error: 'id and command are required' }, 400);
    const session = await chromiumSession(body.id);
    await session.command(body.command);
    return json(await session.snapshot());
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Chromium command failed' }, 500);
  }
}

export async function GET(request: Request) {
  if (!local(request)) return json({ error: 'HII Chromium is local-only' }, 403);
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ error: 'id is required' }, 400);
    return json(await (await chromiumSession(id)).snapshot());
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Chromium snapshot failed' }, 500);
  }
}

export async function DELETE(request: Request) {
  if (!local(request)) return json({ error: 'HII Chromium is local-only' }, 403);
  const id = new URL(request.url).searchParams.get('id');
  if (id) await closeChromiumSession(id);
  return new Response(null, { status: 204 });
}
