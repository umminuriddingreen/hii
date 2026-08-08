import type {
  VoiceExecutionInput,
  VoiceCancelInput,
  VoiceInterpretInput,
  VoiceProposal,
  VoiceRuntimeState
} from '@/lib/voice/types';

export type VoiceApiProposal = VoiceProposal;

export type VoiceApiRuntimeState = VoiceRuntimeState & {
  proposalId?: string;
  queuedRunId?: string;
  actionDescription?: string;
};

export async function voiceInterpret(input: VoiceInterpretInput) {
  const response = await fetch('/api/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'interpret',
      ...input
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Voice interpret failed.');
  }
  return payload as VoiceApiRuntimeState;
}

export async function voiceApprove(input: VoiceExecutionInput) {
  const response = await fetch('/api/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'approve',
      ...input
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Voice approval failed.');
  }
  return payload as VoiceApiRuntimeState;
}

export async function voiceCancel(input: VoiceCancelInput) {
  const response = await fetch('/api/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'cancel',
      ...input
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Voice cancellation failed.');
  }
  return payload as VoiceApiRuntimeState;
}

export async function voiceSnapshot(mode: 'snapshot' | 'proposals' = 'snapshot') {
  const response = await fetch(`/api/voice?mode=${mode}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Voice snapshot failed.');
  }
  return payload as { proposals?: VoiceApiProposal[]; updatedAt?: string; proposalsCount?: number };
}

export async function voiceProposals() {
  return voiceSnapshot('proposals') as Promise<{ proposals: VoiceApiProposal[] }>;
}
