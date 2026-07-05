import { NextResponse } from 'next/server';
import { heartbeatRunner, parseRunnerToken, sanitizeRunnerCapabilities } from '@/lib/server/runners';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function runnerError(error: unknown) {
  if (error instanceof Error && error.name === 'UnauthorizedRunner') {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : 'Runner heartbeat failed.';
  return NextResponse.json({ error: message }, { status: /invalid runner token/i.test(message) ? 403 : 500 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  try {
    const runner = await heartbeatRunner({
      token: parseRunnerToken(request),
      capabilities: sanitizeRunnerCapabilities(body?.capabilities)
    });
    return NextResponse.json({ runner });
  } catch (error) {
    return runnerError(error);
  }
}
