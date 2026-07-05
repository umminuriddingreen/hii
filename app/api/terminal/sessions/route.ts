import { NextResponse } from 'next/server';
import {
  getTerminalSnapshot,
  localTerminalAllowed,
  spawnClaudeAgent
} from '@/lib/server/hii-terminal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII terminal sessions are local-only.' }, { status: 403 });
  }

  const snapshot = await getTerminalSnapshot();
  return NextResponse.json({ agents: snapshot.agents, capturedAt: snapshot.capturedAt });
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII terminal sessions are local-only.' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const preset = String(body?.preset ?? 'observer');
  const prompt = String(body?.prompt ?? '').trim();
  const name = String(body?.name ?? '').trim();

  try {
    const run = await spawnClaudeAgent({ preset, prompt, name });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to spawn agent.' },
      { status: 400 }
    );
  }
}
