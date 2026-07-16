import { NextResponse } from 'next/server';
import {
  closeWindowState,
  getWindowState,
  listWindowStates,
  upsertWindowState,
  WindowStateConflictError
} from '@/lib/server/hii-window-state';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII window state is local-only.' }, { status: 403 });
}

function errorResponse(error: unknown) {
  if (error instanceof WindowStateConflictError) {
    return NextResponse.json({ error: error.message, current: error.current }, { status: 409 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Could not manage HII window state.' },
    { status: 400 }
  );
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const id = query.get('id');
  try {
    if (id) {
      const window = await getWindowState(id);
      return window
        ? NextResponse.json({ window })
        : NextResponse.json({ error: `Window state not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json(
      await listWindowStates({
        workspaceId: query.get('workspaceId') || undefined,
        includeClosed: query.get('includeClosed') === '1',
        limit: query.has('limit') ? Number(query.get('limit')) : undefined,
        cursor: query.get('cursor') || undefined
      })
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json({ window: await upsertWindowState(body) });
  } catch (error) {
    return errorResponse(error);
  }
}

export const PATCH = PUT;

export async function DELETE(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const id = query.get('id');
  if (!id) return NextResponse.json({ error: 'Window id is required.' }, { status: 400 });
  try {
    const baseRevision = query.has('baseRevision') ? Number(query.get('baseRevision')) : undefined;
    return NextResponse.json({ window: await closeWindowState(id, baseRevision) });
  } catch (error) {
    return errorResponse(error);
  }
}
