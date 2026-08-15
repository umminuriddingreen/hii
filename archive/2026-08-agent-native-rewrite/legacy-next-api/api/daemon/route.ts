import { NextResponse } from 'next/server';
import { controlHiiDaemon, getHiiDaemonSnapshot } from '@/lib/server/hii-daemon';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) return NextResponse.json({ error: 'Local access required.' }, { status: 401 });
  return NextResponse.json(await getHiiDaemonSnapshot());
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) return NextResponse.json({ error: 'Local access required.' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    const result = await controlHiiDaemon(action, body ?? {});
    return NextResponse.json({ ok: true, result, snapshot: await getHiiDaemonSnapshot() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Daemon action failed.' }, { status: 400 });
  }
}
