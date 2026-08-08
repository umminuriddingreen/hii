import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  approveContextPack,
  compareContextPackRevisions,
  createContextPack,
  inspectContextPack,
  readContextPacks,
  reviewContextPack,
  reviseContextPack
} from '@/lib/server/context-packs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Context Packs, over the same authority and reference system as everything
 * else. A pack holds pointers; resolution and approval go through the shared
 * resolver, so a pack cannot become a private path to unreviewed content.
 */
function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII context packs are local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  try {
    if (id) return NextResponse.json(await inspectContextPack(id));
    const ledger = await readContextPacks();
    return NextResponse.json({
      packs: ledger.packs,
      corruptRecords: ledger.corruption.length,
      corruption: ledger.corruption.slice(0, 20)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read context packs.' },
      { status: 400 }
    );
  }
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
  const id = String(input.id ?? '');
  try {
    switch (input.action) {
      case 'create':
        return NextResponse.json(await createContextPack(input));
      case 'revise':
        return NextResponse.json(await reviseContextPack(id, input));
      case 'review':
        return NextResponse.json(await reviewContextPack(id, String(input.reviewer ?? '')));
      case 'approve':
        return NextResponse.json(await approveContextPack(id, input));
      case 'compare':
        return NextResponse.json(
          await compareContextPackRevisions(id, Number(input.from), Number(input.to))
        );
      default:
        return NextResponse.json({ error: `Unknown pack action "${String(input.action)}".` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not manage the context pack.' },
      { status: 400 }
    );
  }
}
