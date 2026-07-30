import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  loadWorkspace,
  WorkspaceLoadError,
  WorkspaceRevisionConflictError,
  writeWorkspace
} from '@/lib/server/workspace-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII workspace is local-only' }, { status: 403 });
  }
  try {
    return NextResponse.json(await loadWorkspace());
  } catch (error) {
    if (error instanceof WorkspaceLoadError) {
      return NextResponse.json(
        { status: 'recovery', error: error.message, recoveryPath: error.recoveryPath },
        { status: 500 }
      );
    }
    return NextResponse.json({ status: 'recovery', error: 'HII could not load the workspace.' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII workspace is local-only' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'workspace save payload required' }, { status: 400 });
  }
  const payload = body as { workspace?: unknown; expectedRevision?: unknown };
  try {
    const doc = await writeWorkspace(payload.workspace, Number(payload.expectedRevision));
    return NextResponse.json({ ok: true, workspace: doc });
  } catch (error) {
    if (error instanceof WorkspaceLoadError) {
      return NextResponse.json(
        { error: error.message, code: error.code, recoveryPath: error.recoveryPath },
        { status: 503 }
      );
    }
    if (error instanceof WorkspaceRevisionConflictError) {
      return NextResponse.json(
        { error: error.message, code: error.code, actualRevision: error.actualRevision },
        { status: 409 }
      );
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'HII could not save the workspace.' }, { status: 500 });
  }
}
