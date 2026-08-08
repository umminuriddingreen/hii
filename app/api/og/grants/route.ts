import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  approveObjectGrant,
  describeObjectGrant,
  moveObjectGrantTerritory,
  readObjectGrants,
  reviseObjectGrant,
  revokeObjectGrant
} from '@/lib/server/object-grants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII object grants are local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const ledger = await readObjectGrants();
  return NextResponse.json({
    grants: ledger.grants.map((grant) => ({ ...grant, description: describeObjectGrant(grant) })),
    // Damaged authority records are surfaced, not hidden. A grant history with a
    // hole in it should be visible to the person who has to trust it.
    corruptRecords: ledger.corruption.length,
    corruption: ledger.corruption.slice(0, 20)
  });
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
  try {
    switch (input.action) {
      case 'approve':
        return NextResponse.json({ grant: await approveObjectGrant(input) });
      case 'revise':
        // Widening is a fresh approval, never an edit.
        return NextResponse.json({ grant: await reviseObjectGrant(String(input.id ?? ''), input) });
      case 'revoke':
        return NextResponse.json({
          grant: await revokeObjectGrant(String(input.id ?? ''), String(input.revokedBy ?? ''))
        });
      case 'move-territory':
        // Presentation only. This deliberately cannot change what is permitted.
        return NextResponse.json({
          grant: await moveObjectGrantTerritory(String(input.id ?? ''), input.territory)
        });
      default:
        return NextResponse.json({ error: `Unknown grant action "${String(input.action)}".` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not manage the grant.' },
      { status: 400 }
    );
  }
}
