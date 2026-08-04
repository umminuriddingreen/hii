import { NextResponse } from 'next/server';
import { createSpaceController } from '@/scripts/hii-space.mjs';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII system space is local-only' }, { status: 403 });
  }
  return NextResponse.json(createSpaceController().snapshot());
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII system space is local-only' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || body.action !== 'switch-space' || typeof body.spaceId !== 'string') {
    return NextResponse.json({ error: 'Expected action switch-space and a spaceId' }, { status: 400 });
  }
  const controller = createSpaceController();
  const snapshot = controller.snapshot();
  const spaceId = body.spaceId.trim();
  if (!snapshot.ok || !snapshot.system?.mutationAvailable) {
    return NextResponse.json({ error: snapshot.health?.summary || 'Desktop mutation is unavailable' }, { status: 409 });
  }
  if (!snapshot.system.spaces.some((space: { id: string }) => space.id === spaceId)) {
    return NextResponse.json({ error: 'That system space is not present in the current snapshot' }, { status: 404 });
  }
  const result = controller.action('workspace', ['--', spaceId]);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
