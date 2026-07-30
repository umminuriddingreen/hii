import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  createWorkspace,
  getSelectedWorkspaceId,
  listWorkspaces,
  loadWorkspace,
  WorkspaceLoadError,
  WorkspaceNotFoundError,
  WorkspaceRevisionConflictError,
  selectWorkspace,
  writeWorkspace
} from '@/lib/server/workspace-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII workspace is local-only' }, { status: 403 });
  }
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('list') === '1') {
      return NextResponse.json(await listWorkspaces());
    }
    const workspaceId = url.searchParams.get('workspaceId') || undefined;
    return NextResponse.json(await loadWorkspace(workspaceId));
  } catch (error) {
    if (error instanceof WorkspaceLoadError) {
      return NextResponse.json(
        { status: 'recovery', error: error.message, recoveryPath: error.recoveryPath },
        { status: 500 }
      );
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ status: 'recovery', error: error.message }, { status: 400 });
    }
    return NextResponse.json({ status: 'recovery', error: 'HII could not load the workspace.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
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
    return NextResponse.json({ error: 'workspace action payload required' }, { status: 400 });
  }
  const payload = body as { action?: unknown; workspaceId?: unknown; select?: unknown };
  try {
    if (payload.action === 'create') {
      const result = await createWorkspace(String(payload.workspaceId ?? ''), payload.select !== false);
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }
    if (payload.action === 'select') {
      const result = await selectWorkspace(String(payload.workspaceId ?? ''));
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: 'action must be "create" or "select"' }, { status: 400 });
  } catch (error) {
    if (error instanceof WorkspaceLoadError) {
      return NextResponse.json(
        { error: error.message, code: error.code, recoveryPath: error.recoveryPath },
        { status: 503 }
      );
    }
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 404 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'HII could not update workspaces.' }, { status: 500 });
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
  const payload = body as { workspace?: unknown; expectedRevision?: unknown; workspaceId?: unknown };
  try {
    const workspaceId =
      payload.workspaceId === undefined ? await getSelectedWorkspaceId() : String(payload.workspaceId);
    const doc = await writeWorkspace(payload.workspace, Number(payload.expectedRevision), workspaceId);
    return NextResponse.json({ ok: true, workspaceId, workspace: doc });
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
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 404 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'HII could not save the workspace.' }, { status: 500 });
  }
}
