import { NextResponse } from 'next/server';
import { GraphMutationError } from '@/lib/operational-graph/types';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  ObjectAuthorityError,
  annotateApprovedObject,
  createApprovedObject,
  createApprovedRelation,
  listApprovedObjects,
  patchApprovedObject,
  patchApprovedProjection,
  readApprovedObject,
  tombstoneApprovedObject,
  type ObjectAccessScope
} from '@/lib/server/governed-objects';
import { scopeForGrant } from '@/lib/server/object-grants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The governed object interface, over HTTP.
 *
 * The scope is never taken from the request. A caller names the grant it is
 * acting under and the scope is read from the approved grant ledger — otherwise
 * the caller would be describing its own authority, which is not authority.
 */
function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII object tools are local-only.' }, { status: 403 });
}

function failure(error: unknown) {
  if (error instanceof ObjectAuthorityError) {
    return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: 403 });
  }
  if (error instanceof GraphMutationError) {
    // Structured, so a caller can retry a stale write and give up on a denied one.
    const status = error.code === 'stale-version' || error.code === 'idempotency-conflict' ? 409 : 400;
    return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Could not complete the object operation.' },
    { status: 400 }
  );
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
  const input = (body ?? {}) as Record<string, unknown>;
  const actor = (input.actor ?? {}) as { actorId?: string };
  const grantId = String(input.grantId ?? '');
  if (!grantId) {
    return NextResponse.json({ error: 'A grant id is required.' }, { status: 400 });
  }
  if (!actor.actorId) {
    return NextResponse.json({ error: 'An actor is required.' }, { status: 400 });
  }
  const payload = (input.input ?? {}) as Record<string, never>;
  let scope: ObjectAccessScope;
  try {
    ({ scope } = await scopeForGrant(grantId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'That grant is not usable.', code: 'object-grant-unavailable' },
      { status: 403 }
    );
  }
  try {
    switch (input.operation) {
      case 'list':
        return NextResponse.json({ objects: listApprovedObjects(scope) });
      case 'read':
        return NextResponse.json(readApprovedObject(scope, String(input.objectId ?? '')));
      case 'create':
        return NextResponse.json(createApprovedObject(scope, actor as never, payload));
      case 'patch':
        return NextResponse.json(patchApprovedObject(scope, actor as never, payload));
      case 'annotate':
        return NextResponse.json(annotateApprovedObject(scope, actor as never, payload));
      case 'project':
        return NextResponse.json(patchApprovedProjection(scope, actor as never, payload));
      case 'relate':
        return NextResponse.json(createApprovedRelation(scope, actor as never, payload));
      case 'tombstone':
        return NextResponse.json(tombstoneApprovedObject(scope, actor as never, payload));
      default:
        return NextResponse.json({ error: `Unknown object operation "${String(input.operation)}".` }, { status: 400 });
    }
  } catch (error) {
    return failure(error);
  }
}
