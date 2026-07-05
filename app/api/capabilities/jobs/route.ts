import { NextResponse } from 'next/server';
import { listCapabilityJobs } from '@/lib/capabilities/local-store';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII capability jobs are local-only.' }, { status: 403 });
  }

  const jobs = await listCapabilityJobs({ limit: 50 });
  return NextResponse.json({ jobs });
}
