import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  clearWorkspaceSelection,
  publishWorkspaceSelection,
  readWorkspaceSelection
} from '@/lib/server/workspace-selection-channel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The ephemeral cross-window selection handoff.
 *
 * Coordinates only, held in memory with a short life. Deliberately not part of
 * the Workspace document: selection is transient UI state, and persisting it
 * would make every click a revision and let a stale save resurrect a selection
 * nobody made.
 */
function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII workspace selection is local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || undefined;
  const selection = readWorkspaceSelection(workspaceId);
  // null is a real answer, not an error: nothing is selected, or what was
  // published has expired. Reporting the last known selection instead would let
  // a run be approved against context the human is no longer looking at.
  return NextResponse.json({ selection });
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  try {
    return NextResponse.json({ selection: publishWorkspaceSelection(body) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not publish the selection.' },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') || undefined;
  clearWorkspaceSelection(workspaceId);
  return NextResponse.json({ cleared: true });
}
