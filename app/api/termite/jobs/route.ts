import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createHiiQuote } from '@/lib/server/hii-credits';
import { getCreditDashboard, parseCreditCurrency, reserveCapabilityJob } from '@/lib/server/credits';
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

  const localJobs = await listTermiteJobs(user.id);
  try {
    const dashboard = await getCreditDashboard(user.id, 'usd');
    const durableJobs = dashboard.jobs
      .filter((job) => job.capability_id === 'termite.rhino.managed_job')
      .map((job) => ({
        id: job.id,
        capabilityId: job.capability_id,
        inputSummary: job.input_summary,
        workflow: typeof job.metadata?.workflow === 'string' ? job.metadata.workflow : 'custom-managed-run',
        prompt: job.input_summary,
        budget: job.budget ?? 'quoted-runner',
        status: job.status,
        createdAt: job.created_at,
        runnerId: job.runner_id,
        assignedAt: job.assigned_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        ledger: job.ledger ?? [],
        logs: [
          ...(job.logs ?? []),
          `reserved: ${job.reserved_cents} ${job.currency}`,
          job.runner_id ? `runner: ${job.runner_id}` : 'runner: waiting for approved machine'
        ],
        proofArtifacts: job.proofArtifacts ?? []
      }));
    return NextResponse.json({ jobs: [...durableJobs, ...localJobs] });
  } catch {
    return NextResponse.json({ jobs: localJobs });
  }
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
  const currency = parseCreditCurrency(body?.currency, 'usd');

  if (!workflows.has(workflow)) {
    return NextResponse.json({ error: 'Unknown Termite workflow.' }, { status: 400 });
  }
  if (prompt.length < 10) {
    return NextResponse.json({ error: 'Describe the Rhino task in at least 10 characters.' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json({ error: 'Keep the managed alpha request under 2000 characters.' }, { status: 400 });
  }

  if (budget !== 'alpha-free') {
    const quote = createHiiQuote({
      task: `Termite/Rhino ${workflow}: ${prompt}`,
      currency,
      capabilityId: 'termite.rhino.managed_job',
      maxBudgetCents: budget === 'monthly-managed' ? 50000 : 15000
    });

    if (quote.status === 'over-budget') {
      return NextResponse.json({ error: 'Quote exceeds the selected Termite budget.', quote }, { status: 400 });
    }

    try {
      const durableJob = await reserveCapabilityJob({
        userId: user.id,
        userEmail: user.email ?? null,
        quote,
        transcript: quote.transcript,
        metadata: {
          source: 'api.termite.jobs',
          workflow,
          runnerRequired: true,
          requiredCapabilityId: 'termite.rhino.managed_job',
          proofRequired: ['log']
        }
      });
      return NextResponse.json(
        {
          job: {
            id: durableJob.id,
            capabilityId: durableJob.capability_id,
            inputSummary: durableJob.input_summary,
            workflow,
            prompt,
            budget: durableJob.budget ?? budget,
            status: durableJob.status,
            createdAt: durableJob.created_at,
            ledger: durableJob.ledger ?? [],
            logs: durableJob.logs ?? ['reserved durable HII credits', 'runner: waiting for approved machine'],
            proofArtifacts: durableJob.proofArtifacts ?? []
          },
          quote
        },
        { status: 201 }
      );
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Could not reserve this Termite runner job.', quote },
        { status: 400 }
      );
    }
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
