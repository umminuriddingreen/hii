import { NextResponse } from 'next/server';
import { GraphMutationError } from '@/lib/operational-graph/types';
import {
  createMemoryObject,
  patchMemoryObject,
  readMemoryWorkspace,
  relateMemoryObjects
} from '@/lib/server/hii-memory-workspace';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII memory tools are local-only.' }, { status: 403 });
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function actorFrom(input: Record<string, unknown>) {
  const actor = input.actor && typeof input.actor === 'object' ? input.actor as Record<string, unknown> : {};
  const actorId = text(actor.actorId ?? input.actorId);
  if (!actorId) throw new TypeError('An actor id is required.');
  return {
    actorId,
    deviceId: text(actor.deviceId) || null,
    authorityGrantId: text(actor.authorityGrantId) || null,
    intentId: text(actor.intentId) || text(input.intentId) || null,
    runId: text(actor.runId) || text(input.runId) || null,
    receiptId: text(actor.receiptId) || text(input.receiptId) || null
  };
}

function failure(error: unknown) {
  if (error instanceof GraphMutationError) {
    const status = error.code === 'stale-version' || error.code === 'idempotency-conflict' ? 409 : 400;
    return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Could not complete the memory operation.' },
    { status: 400 }
  );
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const spaceId = text(url.searchParams.get('spaceId'), 'default');
  return NextResponse.json(readMemoryWorkspace(spaceId));
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = text(body?.action);
  const spaceId = text(body?.spaceId, 'default');
  try {
    if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    const actor = actorFrom(body);
    if (action === 'create') {
      return NextResponse.json(createMemoryObject(spaceId, actor, body.input as never), { status: 201 });
    }
    if (action === 'patch') {
      return NextResponse.json(patchMemoryObject(spaceId, actor, body.input as never));
    }
    if (action === 'relate') {
      return NextResponse.json(relateMemoryObjects(spaceId, actor, body.input as never), { status: 201 });
    }
    return NextResponse.json({ error: `Unknown memory action "${action}".` }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
