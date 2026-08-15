import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import { resolveContextRefs, reviewContextResolution } from '@/lib/server/context-refs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve durable context references, and optionally freeze the result into the
 * immutable manifest an approval approves.
 *
 * The caller sends identifiers. Everything is read from its authoritative source
 * here; a browser-supplied excerpt is never treated as canonical.
 */
export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII context resolution is local-only.' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const resolution = await resolveContextRefs(input.refs);
    if (input.review !== true) return NextResponse.json(resolution);
    const workspaceRevision = Number(input.workspaceRevision);
    return NextResponse.json({
      ...resolution,
      manifest: reviewContextResolution(resolution, {
        ...(typeof input.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
        ...(Number.isFinite(workspaceRevision) ? { workspaceRevision } : {})
      })
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not resolve context references.' },
      { status: 400 }
    );
  }
}
