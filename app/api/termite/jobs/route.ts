import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createTermiteJob, listTermiteJobs } from '@/lib/server/termite-jobs';

export const dynamic = 'force-dynamic';

const workflows = new Set([
  'rhino-smoke-test',
  'geometry-check',
  'viewport-proof',
  'export-readiness',
  'custom-managed-run'
]);

export async function GET() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });

  const jobs = await listTermiteJobs(user.id);
  return NextResponse.json({ jobs });
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workflow = String(body?.workflow ?? '').trim();
  const prompt = String(body?.prompt ?? '').trim();
  const budget = String(body?.budget ?? 'alpha').trim() || 'alpha';

  if (!workflows.has(workflow)) {
    return NextResponse.json({ error: 'Unknown Termite workflow.' }, { status: 400 });
  }
  if (prompt.length < 10) {
    return NextResponse.json({ error: 'Describe the Rhino task in at least 10 characters.' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json({ error: 'Keep the managed alpha request under 2000 characters.' }, { status: 400 });
  }

  const job = await createTermiteJob({
    userId: user.id,
    email: user.email ?? null,
    workflow,
    prompt,
    budget
  });

  return NextResponse.json({ job }, { status: 201 });
}

