import { NextResponse } from 'next/server';
import { getCapability } from '@/lib/capabilities';
import { listCapabilityJobs } from '@/lib/capabilities/local-store';
import { createHiiQuote } from '@/lib/server/hii-credits';
import { getCreditDashboard, parseCreditCurrency, reserveCapabilityJob } from '@/lib/server/credits';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    const currency = parseCreditCurrency(new URL(request.url).searchParams.get('currency'));
    const dashboard = await getCreditDashboard(user.id, currency);
    return NextResponse.json({ jobs: dashboard.jobs, ledger: dashboard.ledger });
  }

  if (localTerminalAllowed(request)) {
    const jobs = await listCapabilityJobs({ limit: 50 });
    return NextResponse.json({ jobs });
  }

  return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const task = typeof body?.task === 'string' ? body.task.trim() : '';
  const currency = parseCreditCurrency(body?.currency);
  const capabilityId =
    typeof body?.capabilityId === 'string' && getCapability(body.capabilityId)
      ? body.capabilityId
      : 'hii.agent.spawn';
  const maxBudgetCents =
    typeof body?.maxBudgetCents === 'number' && Number.isFinite(body.maxBudgetCents)
      ? Math.max(100, Math.round(body.maxBudgetCents))
      : undefined;

  if (task.length < 8) {
    return NextResponse.json({ error: 'Describe the task in at least 8 characters.' }, { status: 400 });
  }
  if (task.length > 4000) {
    return NextResponse.json({ error: 'Keep the task under 4000 characters.' }, { status: 400 });
  }

  const quote = createHiiQuote({ task, currency, maxBudgetCents, capabilityId });
  if (quote.status === 'over-budget') {
    return NextResponse.json({ error: 'Quote exceeds the selected max budget.', quote }, { status: 400 });
  }

  try {
    const job = await reserveCapabilityJob({
      userId: user.id,
      userEmail: user.email ?? null,
      quote,
      transcript: quote.transcript,
      metadata: {
        source: 'api.capabilities.jobs'
      }
    });
    const dashboard = await getCreditDashboard(user.id, currency);
    return NextResponse.json({ job, quote, account: dashboard.account, ledger: dashboard.ledger }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not reserve credits for this job.', quote },
      { status: 400 }
    );
  }
}
