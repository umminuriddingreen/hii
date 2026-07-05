import { NextResponse } from 'next/server';
import { appendRunnerJobEvents, parseRunnerToken } from '@/lib/server/runners';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function runnerError(error: unknown) {
  if (error instanceof Error && error.name === 'UnauthorizedRunner') {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : 'Could not append runner job events.';
  return NextResponse.json(
    { error: message },
    { status: /invalid runner token/i.test(message) ? 403 : /cannot update/i.test(message) ? 403 : 500 }
  );
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}));
  const events = Array.isArray(body?.events)
    ? body.events
        .filter((event: unknown): event is { actor?: string; text: string } => {
          return typeof event === 'object' && event !== null && typeof (event as { text?: unknown }).text === 'string';
        })
        .map((event: { actor?: string; text: string }) => ({
          actor: typeof event.actor === 'string' ? event.actor : 'agent',
          text: event.text.slice(0, 2000)
        }))
    : [];

  if (events.length < 1) {
    return NextResponse.json({ error: 'At least one runner event is required.' }, { status: 400 });
  }

  try {
    const job = await appendRunnerJobEvents({ token: parseRunnerToken(request), jobId: params.id, events });
    return NextResponse.json({ job });
  } catch (error) {
    return runnerError(error);
  }
}
