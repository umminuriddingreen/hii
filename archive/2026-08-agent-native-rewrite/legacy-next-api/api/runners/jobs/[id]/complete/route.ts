import { NextResponse } from 'next/server';
import { completeRunnerJob, parseRunnerToken, type RunnerProofArtifact } from '@/lib/server/runners';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const proofKinds = new Set(['log', 'screenshot', 'download', 'receipt', 'link', 'json']);

function runnerError(error: unknown) {
  if (error instanceof Error && error.name === 'UnauthorizedRunner') {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : 'Could not complete runner job.';
  return NextResponse.json(
    { error: message },
    { status: /invalid runner token/i.test(message) ? 403 : /cannot update|require at least/i.test(message) ? 400 : 500 }
  );
}

function parseProof(value: unknown): RunnerProofArtifact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      kind: typeof item.kind === 'string' && proofKinds.has(item.kind) ? (item.kind as RunnerProofArtifact['kind']) : 'log',
      label: typeof item.label === 'string' ? item.label.slice(0, 120) : 'Runner log',
      href: typeof item.href === 'string' ? item.href.slice(0, 1000) : undefined,
      path: typeof item.path === 'string' ? item.path.slice(0, 1000) : undefined,
      summary: typeof item.summary === 'string' ? item.summary.slice(0, 2000) : undefined
    }));
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}));
  const status = body?.status === 'failed' ? 'failed' : 'completed';
  const proof = parseProof(body?.proof);
  const summary =
    typeof body?.summary === 'string' && body.summary.trim()
      ? body.summary.trim().slice(0, 2000)
      : status === 'completed'
        ? 'Runner completed the capability job.'
        : 'Runner failed the capability job.';

  if (status === 'completed' && proof.length < 1) {
    return NextResponse.json({ error: 'Completed runner jobs require at least one proof artifact.' }, { status: 400 });
  }

  try {
    const job = await completeRunnerJob({
      token: parseRunnerToken(request),
      jobId: params.id,
      status,
      computeCostCents: Number(body?.computeCostCents ?? 0),
      platformFeeCents: Number(body?.platformFeeCents ?? 0),
      summary,
      proof,
      transcript: Array.isArray(body?.transcript) ? body.transcript : []
    });
    return NextResponse.json({ job });
  } catch (error) {
    return runnerError(error);
  }
}
