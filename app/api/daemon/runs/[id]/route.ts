import { NextResponse } from 'next/server';
import { getHiiDaemonRun } from '@/lib/server/hii-daemon';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!localTerminalAllowed(request)) return NextResponse.json({ error: 'Local access required.' }, { status: 401 });
  const run = await getHiiDaemonRun(params.id);
  if (!run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  return NextResponse.json(run);
}
