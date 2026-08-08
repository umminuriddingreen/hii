import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  cancelVoiceProposal,
  executeVoiceProposal,
  interpretVoiceInput,
  listVoiceProposals,
  snapshotVoiceRuntimeState
} from '@/lib/server/hii-voice';

function denied() {
  return json({ error: 'Local HII access required.' }, { status: 401 });
}

export const GET: RequestHandler = async ({ request, url }) => {
  if (!localTerminalAllowed(request)) return denied();
  const mode = url.searchParams.get('mode') || 'snapshot';
  try {
    if (mode === 'state' || mode === 'snapshot') {
      return json(await snapshotVoiceRuntimeState());
    }
    if (mode === 'proposals') {
      const proposals = await listVoiceProposals(80);
      return json({
        proposals,
        proposalsCount: proposals.length
      });
    }
    return json({ error: 'Unknown voice mode.' }, { status: 400 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Voice state failed.' }, { status: 400 });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  if (!localTerminalAllowed(request)) return denied();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';

  try {
    const normalizedUtterance = typeof body?.utterance === 'string'
      ? String(body.utterance).trim().slice(0, 6000)
      : '';
    const requestedBy = typeof body?.requestedBy === 'string'
      ? String(body.requestedBy).trim().slice(0, 120).replace(/[^a-zA-Z0-9._-]/g, '')
      : 'notch';
    const proposalId = typeof body?.proposalId === 'string'
      ? String(body.proposalId).trim().slice(0, 120).replace(/[^a-zA-Z0-9-]/g, '')
      : '';

    if (action === 'interpret') {
      if (!normalizedUtterance) return json({ error: 'A voice utterance is required.' }, { status: 400 });
      return json(await interpretVoiceInput(normalizedUtterance, {
        utterance: normalizedUtterance,
        requestedBy,
        model: typeof body?.model === 'string' ? body.model : undefined,
        platform: typeof body?.platform === 'string' ? body.platform : undefined,
        requireApproval: body?.requireApproval === true,
        references: Array.isArray(body?.references) ? body.references : [],
        workspace: body?.workspace && typeof body.workspace === 'object' ? body.workspace : undefined
      }));
    }

    if (action === 'approve') {
      if (!proposalId) return json({ error: 'proposalId is required.' }, { status: 400 });
      return json(await executeVoiceProposal({
        proposalId,
        requestedBy
      }), { status: 201 });
    }

    if (action === 'cancel') {
      if (!proposalId) return json({ error: 'proposalId is required.' }, { status: 400 });
      return json(await cancelVoiceProposal({
        proposalId,
        reason: typeof body?.reason === 'string' ? String(body.reason).slice(0, 500) : undefined,
        requestedBy
      }));
    }

    if (action === 'proposals') {
      const proposals = await listVoiceProposals(80);
      return json({ proposals, proposalsCount: proposals.length });
    }

    return json({ error: 'Unknown voice action.' }, { status: 400 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Voice processing failed.' }, { status: 400 });
  }
};
