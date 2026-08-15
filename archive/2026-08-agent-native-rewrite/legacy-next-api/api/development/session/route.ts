import { NextResponse } from 'next/server';
import { developmentSessionSnapshot, ensureDevelopmentSession } from '@/lib/server/hii-development';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII development sessions are local-only' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  return denied || NextResponse.json(await developmentSessionSnapshot());
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  if (!body || body.action !== 'start') {
    return NextResponse.json({ error: 'Expected action start' }, { status: 400 });
  }
  const snapshot = await ensureDevelopmentSession();
  return NextResponse.json(snapshot, { status: snapshot.web.ready ? 200 : 503 });
}
