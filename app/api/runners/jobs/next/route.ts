import { NextResponse } from 'next/server';
import { claimNextRunnerJob, parseRunnerToken, sanitizeRunnerCapabilities } from '@/lib/server/runners';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function runnerError(error: unknown) {
  if (error instanceof Error && error.name === 'UnauthorizedRunner') {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : 'Could not claim runner job.';
  return NextResponse.json({ error: message }, { status: /invalid runner token/i.test(message) ? 403 : 500 });
}

export async function GET(request: Request) {
  const capabilities = sanitizeRunnerCapabilities(new URL(request.url).searchParams.getAll('capability'));
  try {
    const job = await claimNextRunnerJob({ token: parseRunnerToken(request), capabilities });
    return NextResponse.json({ job });
  } catch (error) {
    return runnerError(error);
  }
}
