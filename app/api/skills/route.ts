import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import { listRegisteredHiiSkills, startRegisteredHiiSkill } from '@/lib/server/hii-skills';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII skills are local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  return NextResponse.json({ skills: await listRegisteredHiiSkills() });
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return NextResponse.json({ error: 'A registered skill id is required.' }, { status: 400 });
  }
  try {
    const result = await startRegisteredHiiSkill(id);
    return NextResponse.json({ ok: true, runId: result.runId, message: result.stdout });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not start the HII skill.' },
      { status: 400 }
    );
  }
}
