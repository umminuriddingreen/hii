import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import { approvalMatchesManifest } from '@/lib/server/context-refs';
import { workspaceRunCompletion } from '@/lib/server/workspace-run-completion';
import { getWorkspaceRun, queueApprovedWorkspaceRun } from '@/lib/server/hii-workspace-runs';
import {
  materializeVariantBranch,
  prepareVariantBranch,
  variantRunGoal,
  type VariantProposal
} from '@/lib/server/workspace-variant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The generative branch: prepare, approve, materialize.
 *
 * Split into three calls on purpose. Preparation creates nothing and produces
 * the manifest a human reviews; approval is a separate act that must quote the
 * fingerprint it saw; materialization happens only after the run's own verdict
 * says the declared outcome was met.
 */
function localOnly(request: Request) {
  return localTerminalAllowed(request)
    ? null
    : NextResponse.json({ error: 'HII variants are local-only.' }, { status: 403 });
}

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Could not create the variant.' },
    { status: 400 }
  );
}

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  try {
    if (input.action === 'prepare') {
      return NextResponse.json(await prepareVariantBranch(input));
    }

    if (input.action === 'approve') {
      const proposal = input.proposal as VariantProposal | undefined;
      if (!proposal?.branchId) throw new Error('A prepared variant proposal is required.');
      // The approval must quote what it saw. Without this the human could review
      // one manifest and the run execute against another.
      if (!approvalMatchesManifest(proposal.manifest, input.approvedFingerprint)) {
        throw new Error('The context changed after review. Prepare the variant again before approving.');
      }
      const queued = await queueApprovedWorkspaceRun({
        goal: variantRunGoal(proposal),
        workspaceRoot: input.workspaceRoot,
        model: input.model,
        maxSteps: input.maxSteps,
        context: proposal.manifest.entries.map((entry) => ({
          id: entry.ref.id,
          title: entry.title,
          type: entry.type,
          ...(entry.source ? { source: entry.source } : {}),
          ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
          ...(entry.sha256 ? { expectedSha256: entry.sha256 } : {})
        })),
        contextFingerprint: input.contextFingerprint,
        approved: true,
        requestedBy: 'hii.workspace.variant'
      });
      return NextResponse.json({ ...queued, proposal });
    }

    if (input.action === 'materialize') {
      const proposal = input.proposal as VariantProposal | undefined;
      const runId = String(input.runId ?? '');
      if (!proposal?.branchId || !runId) {
        throw new Error('A prepared variant proposal and a run id are required.');
      }
      const run = await getWorkspaceRun(runId);
      if (!run) throw new Error('That run was not found.');
      return NextResponse.json(
        await materializeVariantBranch({
          proposal,
          runId,
          receiptPath: run.path,
          workspaceRoot: String(run.job.metadata?.workspaceRoot ?? ''),
          completion: run.completion ?? workspaceRunCompletion(run.receipt)
        })
      );
    }

    return NextResponse.json({ error: `Unknown variant action "${String(input.action)}".` }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
