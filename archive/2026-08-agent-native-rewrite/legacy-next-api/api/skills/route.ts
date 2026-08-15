import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  getHiiSkillReplayDetail,
  listRegisteredHiiSkills,
  registerHiiSkillDraft,
  startRegisteredHiiSkill
} from '@/lib/server/hii-skills';

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
  const id = new URL(request.url).searchParams.get('id');
  if (id) {
    try {
      const detail = await getHiiSkillReplayDetail(id);
      return detail
        ? NextResponse.json(detail)
        : NextResponse.json({ error: 'HII skill not found.' }, { status: 404 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Could not read the HII skill.' },
        { status: 400 }
      );
    }
  }
  return NextResponse.json({ skills: await listRegisteredHiiSkills() });
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return NextResponse.json({ error: 'A valid HII skill id is required.' }, { status: 400 });
  }
  try {
    if (body?.action === 'register') {
      const skill = await registerHiiSkillDraft({
        id,
        reviewedBy: body.reviewedBy,
        approved: body.approved
      });
      return NextResponse.json({ ok: true, skill });
    }
    if (body?.action === 'replay') {
      const result = await startRegisteredHiiSkill({ id, approved: body.approved });
      return NextResponse.json({
        ok: true,
        runId: result.runId,
        replay: result.replay,
        message: result.stdout
      }, { status: 202 });
    }
    return NextResponse.json(
      { error: 'Action must be register or replay.' },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not update the HII skill.' },
      { status: 400 }
    );
  }
}
