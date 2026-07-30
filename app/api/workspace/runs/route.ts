import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  createWorkspaceRunCapabilityDraft,
  discoverWorkspaceRunModels,
  getWorkspaceRun,
  previewWorkspaceRunContext,
  queueApprovedWorkspaceRun,
  requestWorkspaceRunCancellation
} from '@/lib/server/hii-workspace-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII workspace runs are local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    if (params.get('mode') === 'models') {
      return NextResponse.json(await discoverWorkspaceRunModels());
    }
    const id = params.get('id');
    const result = await getWorkspaceRun(id);
    return result
      ? NextResponse.json(result)
      : NextResponse.json({ error: 'Workspace run not found.' }, { status: 404 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read the workspace run.' },
      { status: 400 }
    );
  }
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Workspace run payload required.' }, { status: 400 });
  try {
    if (body.action === 'preview-context') {
      return NextResponse.json({
        ok: true,
        preview: await previewWorkspaceRunContext({
          workspaceRoot: body.workspaceRoot,
          context: body.context
        })
      });
    }
    if (body.action === 'approve') {
      return NextResponse.json({
        ok: true,
        ...(await queueApprovedWorkspaceRun({
          id: body.id,
          projectId: body.projectId,
          goal: body.goal,
          workspaceRoot: body.workspaceRoot,
          model: body.model,
          maxSteps: body.maxSteps,
          context: body.context,
          contextFingerprint: body.contextFingerprint,
          approved: body.approved,
          requestedBy: 'hii.workspace'
        }))
      }, { status: 201 });
    }
    if (body.action === 'draft-capability') {
      return NextResponse.json({
        ok: true,
        draft: await createWorkspaceRunCapabilityDraft({ id: body.id, name: body.name })
      });
    }
    if (body.action === 'cancel') {
      return NextResponse.json({
        ok: true,
        ...(await requestWorkspaceRunCancellation({ id: body.id, requestedBy: 'hii.workspace' }))
      }, { status: 202 });
    }
    return NextResponse.json(
      { error: 'Action must be preview-context, approve, cancel, or draft-capability.' },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not update the workspace run.' },
      { status: 400 }
    );
  }
}
