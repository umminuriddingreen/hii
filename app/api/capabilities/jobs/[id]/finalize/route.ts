import { NextResponse } from 'next/server';
import { finalizeCapabilityJob, getCreditDashboard, parseCreditCurrency } from '@/lib/server/credits';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const status = String(body?.status ?? 'completed');
  const computeCostCents =
    typeof body?.computeCostCents === 'number' && Number.isFinite(body.computeCostCents)
      ? Math.max(0, Math.round(body.computeCostCents))
      : 0;
  const platformFeeCents =
    typeof body?.platformFeeCents === 'number' && Number.isFinite(body.platformFeeCents)
      ? Math.max(0, Math.round(body.platformFeeCents))
      : 0;
  const summary =
    typeof body?.summary === 'string' && body.summary.trim()
      ? body.summary.trim().slice(0, 1000)
      : 'Capability job finalized.';
  const currency = parseCreditCurrency(body?.currency);

  if (!terminalStatuses.has(status)) {
    return NextResponse.json({ error: 'Status must be completed, failed, or cancelled.' }, { status: 400 });
  }

  try {
    await finalizeCapabilityJob({
      userId: user.id,
      jobId: params.id,
      status: status as 'completed' | 'failed' | 'cancelled',
      computeCostCents,
      platformFeeCents,
      summary,
      proof: Array.isArray(body?.proof) ? body.proof : [],
      transcript: Array.isArray(body?.transcript) ? body.transcript : []
    });
    const dashboard = await getCreditDashboard(user.id, currency);
    return NextResponse.json({ ok: true, ledger: dashboard.ledger });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not finalize this capability job.' },
      { status: 400 }
    );
  }
}
