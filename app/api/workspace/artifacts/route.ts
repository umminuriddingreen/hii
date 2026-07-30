import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  readWorkspaceRunArtifact,
  saveWorkspaceRunArtifact
} from '@/lib/server/hii-workspace-artifacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII workspace artifacts are local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await readWorkspaceRunArtifact({
      runId: params.get('runId'),
      artifact: params.get('artifact')
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not open the workspace artifact.' },
      { status: Number((error as { status?: unknown })?.status) || 400 }
    );
  }
}

export async function PATCH(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Workspace artifact payload required.' }, { status: 400 });
  try {
    return NextResponse.json({
      ok: true,
      artifact: await saveWorkspaceRunArtifact({
        runId: body.runId,
        artifact: body.artifact,
        content: body.content,
        ifMatch: body.ifMatch
      })
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not save the workspace artifact.' },
      { status: Number((error as { status?: unknown })?.status) || 400 }
    );
  }
}
