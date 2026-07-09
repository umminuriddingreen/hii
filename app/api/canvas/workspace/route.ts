import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import { readWorkspace, writeWorkspace } from '@/lib/server/canvas-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'canvas is local-only' }, { status: 403 });
  }
  return NextResponse.json(await readWorkspace());
}

export async function PUT(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'canvas is local-only' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const doc = await writeWorkspace(body);
  return NextResponse.json({ ok: true, updatedAt: doc.updatedAt });
}
