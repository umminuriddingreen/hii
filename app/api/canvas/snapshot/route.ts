import { NextResponse } from 'next/server';
import { getSpatialWorkspaceSnapshot } from '@/lib/server/hii-spatial-workspace';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'canvas snapshot is local-only' }, { status: 403 });
  }
  return NextResponse.json(await getSpatialWorkspaceSnapshot());
}
