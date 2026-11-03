import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeWorkspaceRunContext } from '@/lib/server/hii-workspace-run-context';
import {
  readVoiceProposalLedger,
  recordProposalCreated,
  recordProposalTransition
} from '@/lib/server/voice-proposal-ledger';
import {
  buildVoiceContextSnapshot,
  normalizeContextReferences
} from '@/lib/voice/context';
import {
  interpretVoiceUtterance
} from '@/lib/voice/interpreter';
import { assembleVoiceVocabulary } from '@/lib/voice/vocabulary';
import type {
  VoiceIntent,
  VoiceInterpretInput,
  VoiceExecutionInput,
  VoiceCancelInput,
  VoiceProposal,
  VoiceRuntimeEngine,
  VoiceRuntimeState
} from '@/lib/voice/types';
import {
  discoverWorkspaceRunModels,
  getWorkspaceRun,
  previewWorkspaceRunContext,
  queueApprovedWorkspaceRun,
  requestWorkspaceRunCancellation
} from '@/lib/server/hii-workspace-runs';
import { appendCapabilityJob } from '@/lib/capabilities/local-store';
import { recordEcosystemEvent } from '@/lib/server/hii-ecosystem';

type VoiceRuntimeError = {
  code: string;
  message: string;
};

const runtimeRoot = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
const voiceRoot = path.join(runtimeRoot, 'voice');
const intentsPath = path.join(voiceRoot, 'intents.jsonl');
const proposalsPath = path.join(voiceRoot, 'proposals.jsonl');
const conversationPath = path.join(voiceRoot, 'conversations.jsonl');

function sanitizeProposalId(value: unknown, fieldName = 'proposalId') {
  const text = String(value ?? '').trim().slice(0, 120).replace(/[^a-zA-Z0-9-]/g, '');
  if (!text) throw new Error(`${fieldName} is required.`);
  return text;
}

function sanitizeSummary(value: unknown) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function sanitizeText(value: unknown, max = 120) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fromError(error: unknown): VoiceRuntimeError {
  return {
    code: 'VOICE_RUNTIME',
    message: error instanceof Error ? sanitizeText(error.message, 1200) : 'Voice processing failed.'
  };
}

async function appendJsonl(filePath: string, payload: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

/** Current proposal state folded from the append-only transition ledger. */
async function readProposalsInFileOrder() {
  const ledger = await readVoiceProposalLedger(proposalsPath);
  return ledger.proposals;
}

async function emitVoiceEvent(input: {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  proposalId: string;
  runId?: string;
}) {
  try {
    await recordEcosystemEvent({
      mode: 'notch',
      projectId: 'default',
      status: input.status,
      summary: sanitizeSummary(input.summary),
      object: {
        kind: 'run',
        id: input.runId || input.proposalId
      }
    });
  } catch {
    // Ecosystem emissions are informative-only for voice runtime hardening.
  }
}

/**
 * Appends one immutable status transition to the proposal ledger.
 *
 * Nothing already written is rewritten, reordered or removed: the transition is
 * a new line recording the previous and resulting status. The append runs under
 * the shared HII file lock, so concurrent transitions cannot lose each other,
 * and `transitionKey` makes a retried transition idempotent instead of
 * producing a duplicate event.
 */
async function writeProposalStatus(
  id: string,
  status: VoiceProposal['status'],
  patch: Partial<VoiceProposal> = {},
  transitionKey?: string
) {
  return recordProposalTransition(proposalsPath, { proposalId: id, status, patch, transitionKey });
}

/** Records a newly captured proposal as the opening event of its ledger entry. */
async function appendProposal(proposal: VoiceProposal) {
  await recordProposalCreated(proposalsPath, proposal);
}

/**
 * The only speech engine HII currently ships with.
 *
 * Web Speech recognition is performed by the browser, which on several engines
 * uploads audio to a platform service. HII cannot prove that transport, so the
 * engine is reported as browser-managed. Claiming local-only here would be a
 * privacy assertion the runtime cannot back.
 */
function browserSpeechEngine(): VoiceRuntimeEngine {
  return {
    id: 'web-speech',
    name: 'Browser/Web Speech',
    transport: 'local-browser',
    speechProcessing: 'browser-managed',
    privacyNotice:
      'Speech is transcribed by the browser. Some browsers send captured audio to a platform speech service. HII cannot verify that transport, so this is not local-only.',
    ready: true,
    latencyHint: 'interactive'
  };
}

function canExecute(status: VoiceProposal['status']) {
  return ['pending', 'queued'].includes(status);
}

function proposalForResponse(proposal: VoiceProposal) {
  return {
    ...proposal
  };
}

export async function snapshotVoiceRuntimeState() {
  const ledger = await readVoiceProposalLedger(proposalsPath);
  const proposals = ledger.proposals;
  return {
    updatedAt: new Date().toISOString(),
    intentFile: intentsPath,
    proposalCount: proposals.length,
    activeEngines: [browserSpeechEngine()],
    pendingApprovals: proposals.filter((proposal) => proposal.status === 'pending').length,
    proposalsCount: proposals.filter((proposal) => proposal.status !== 'failed' && proposal.status !== 'cancelled').length,
    // Corrupt ledger lines stay in the file and remain visible in runtime state.
    ledger: {
      path: proposalsPath,
      eventCount: ledger.events.length,
      lineCount: ledger.lineCount,
      corruptRecords: ledger.corruption.length,
      corruption: ledger.corruption.slice(0, 20).map((entry) => ({
        line: entry.line,
        reason: entry.reason,
        proposalId: entry.proposalId
      }))
    }
  };
}

export async function interpretVoiceInput(raw: string, rawInput?: VoiceInterpretInput) {
  const transcript = sanitizeText(
    typeof raw === 'string'
      ? raw
      : '',
    6000
  );
  const references = normalizeContextReferences(rawInput?.references ?? []);
  // Loaded on demand: resolving a selection reaches the workspace store and the
  // operational graph, which the proposal and cancellation paths never need.
  const { normalizeVoiceWorkspaceSelection, resolveVoiceWorkspaceContext } = await import(
    '@/lib/server/hii-voice-workspace-context'
  );
  const workspaceContext = await resolveVoiceWorkspaceContext(
    normalizeVoiceWorkspaceSelection(rawInput?.workspace)
  );
  const baseContext = await buildVoiceContextSnapshot(references);
  const context = {
    ...baseContext,
    speechProcessing: browserSpeechEngine().speechProcessing,
    ...(workspaceContext.selectedText ? { selectedText: workspaceContext.selectedText } : {}),
    workspace: {
      workspaceId: workspaceContext.workspaceId,
      workspaceRevision: workspaceContext.workspaceRevision,
      available: workspaceContext.available,
      selectedNodeIds: workspaceContext.selectedNodeIds,
      unresolvedNodeIds: workspaceContext.unresolvedNodeIds,
      ...(workspaceContext.sceneId ? { sceneId: workspaceContext.sceneId } : {}),
      ...(workspaceContext.sceneTitle ? { sceneTitle: workspaceContext.sceneTitle } : {}),
      notice: workspaceContext.notice
    }
  };
  const vocabulary = assembleVoiceVocabulary({
    global: ['hii', 'workspace', 'go', 'send', 'send it', 'make', 'change', 'that', 'this'],
    conversationReferences: references,
    repo: [context.projectPath || '']
  });

  const intent = interpretVoiceUtterance(transcript, context);
  if (!intent.proposedAction && intent.mode !== 'dictate' && intent.mode !== 'ask') {
    intent.proposedAction = {
      capabilityId: 'hii.agent.workspace_run',
      purpose: `${intent.mode} with context-aware voice`,
      inputs: {
        goal: intent.normalizedText ?? intent.utterance,
        contextId: context.snapshotAt,
        purpose: intent.mode
      },
      expectedOutputs: ['workspace run', 'receipt'],
      requiresApproval: false
    };
  }
  intent.approvalRequired = false;

  const confidence = Math.max(0, Math.min(1, intent.confidence));
  const runtimeState: VoiceRuntimeState = {
    intent: { ...intent, confidence },
    requiresUserAction: intent.mode === 'ask' || intent.mode === 'dictate',
    message: intent.mode === 'dictate'
      ? 'Dictate captured and staged in conversation memory.'
      : 'Voice intent interpreted.'
  };

  const normalizedText = intent.normalizedText || intent.utterance;
  const proposalId = randomUUID();
  const proposal = intent.proposedAction
    ? ({
        id: proposalId,
        contextSnapshot: context,
        utterance: intent.utterance,
        normalizedText,
        mode: intent.mode,
        confidence,
        purpose: intent.proposedAction.purpose,
        capabilityId: intent.proposedAction.capabilityId,
        inputs: intent.proposedAction.inputs,
        context: workspaceContext.items,
        workspaceRoot: String(intent.proposedAction.inputs.projectPath || context.projectPath || ''),
        createdAt: context.snapshotAt,
        status: 'pending'
      } as VoiceProposal)
    : undefined;
  let responseProposal = proposal;

  await appendJsonl(intentsPath, {
    id: randomUUID(),
    ...intent,
    confidence,
    vocabularySample: vocabulary.slice(0, 40).map((entry) => entry.text),
    createdAt: context.snapshotAt
  });
  await appendJsonl(conversationPath, {
    id: randomUUID(),
    text: normalizedText,
    mode: intent.mode,
    confidence,
    ts: context.snapshotAt
  });

  if (proposal) {
    await appendProposal(proposal);
    runtimeState.proposalId = proposal.id;
    runtimeState.actionDescription = proposal.purpose;
    try {
      const execution = await executeVoiceProposal({ proposalId: proposal.id, requestedBy: 'hii.voice' });
      runtimeState.requiresUserAction = false;
      runtimeState.message = `Voice action queued as workspace run ${execution.queuedRunId}.`;
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : 'Voice action could not be queued.', 1200);
      await writeProposalStatus(proposal.id, 'failed', { lastError: message });
      runtimeState.requiresUserAction = false;
      runtimeState.message = `Voice action could not be queued: ${message}`;
    }
    const currentProposal = (await readProposalsInFileOrder()).find((entry) => entry.id === proposal.id) || proposal;
    responseProposal = currentProposal;
    await emitVoiceEvent({
      status: currentProposal.status === 'executed' ? 'queued' : 'failed',
      summary: currentProposal.status === 'executed'
        ? `Queued voice action ${proposalId} as workspace run ${currentProposal.jobId || ''}`
        : `Voice action ${proposalId} could not be queued`,
      proposalId,
      runId: currentProposal.jobId
    });
  }

  return {
    ...runtimeState,
    proposalId: responseProposal?.id,
    actionDescription: runtimeState.actionDescription || responseProposal?.purpose,
    workspaceContext: {
      workspaceId: workspaceContext.workspaceId,
      available: workspaceContext.available,
      resolvedCount: workspaceContext.items.length,
      unresolvedNodeIds: workspaceContext.unresolvedNodeIds,
      notice: workspaceContext.notice
    },
    speech: browserSpeechEngine(),
    proposal: responseProposal ? proposalForResponse(responseProposal) : undefined
  };
}

export async function listVoiceProposals(limit = 120) {
  const proposals = await readProposalsInFileOrder();
  return proposals
    .filter((proposal) => proposal?.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(240, limit)));
}

export async function executeVoiceProposal(input: VoiceExecutionInput) {
  const proposalId = sanitizeProposalId(input?.proposalId, 'proposalId');
  const requestedBy = sanitizeProposalId(input?.requestedBy || 'hii.voice', 'requestedBy');
  const proposals = await readProposalsInFileOrder();
  const proposal = proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found.`);
  if (proposal.status === 'executed') {
    return { ok: true, message: 'Proposal was already executed.', proposal: proposalForResponse(proposal), queuedRunId: proposal.jobId };
  }
  if (!canExecute(proposal.status)) {
    throw new Error(`Proposal ${proposal.id} is not executable in status ${proposal.status}.`);
  }
  if (proposal.capabilityId !== 'hii.agent.workspace_run') {
    throw new Error(`Unsupported capability: ${proposal.capabilityId}`);
  }

  const modelData = await discoverWorkspaceRunModels();
  const model = String(proposal.inputs.model || modelData.defaultModel || '');
  if (!modelData.available || !model) {
    throw new Error('No workspace run model is currently available.');
  }

  const workspaceRoot = String(
    proposal.workspaceRoot || proposal.inputs.projectPath || proposal.contextSnapshot?.projectPath || process.cwd()
  );
  // Execute the context captured with the utterance so provenance stays attached.
  const capturedContext = normalizeWorkspaceRunContext(proposal.context);
  const contextPreview = await previewWorkspaceRunContext({
    runId: proposal.id,
    workspaceRoot,
    context: capturedContext
  });
  if (contextPreview.blocked) {
    throw new Error(`Workspace run context could not be built: ${contextPreview.blockers.join(' ')}`);
  }

  // Empty rather than undefined: JSON drops undefined, so an explicit clear has
  // to be a value the ledger can carry.
  await writeProposalStatus(proposal.id, 'queued', { lastError: '' });
  const execution = await queueApprovedWorkspaceRun({
    id: proposal.id,
    projectId: 'hii-voice',
    goal: proposal.normalizedText,
    workspaceRoot,
    model: String(model),
    maxSteps: 8,
    context: capturedContext,
    contextFingerprint: contextPreview.fingerprint,
    requestedBy
  });
  await writeProposalStatus(proposal.id, 'executed', {
    jobId: execution.job.id,
    receipts: [...(execution.job.proofArtifacts ?? []).map((artifact) => artifact.path || '').filter(Boolean)]
  });
  await appendCapabilityJob({
    id: randomUUID(),
    capabilityId: 'hii.voice.action',
    inputSummary: `voice action execution ${proposal.normalizedText.slice(0, 200)}`,
    userId: 'local',
    userEmail: null,
    status: 'queued',
    budget: 'local-voice',
    logs: [
      `[${new Date().toISOString()}] queued voice action ${proposal.id} requested by ${requestedBy}`
    ],
    ledger: [],
    proofArtifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      voiceProposalId: proposal.id,
      workspaceRunId: execution.job.id,
      model,
      workspaceRoot,
      mode: proposal.mode
    }
  });
  return {
    ok: true,
    message: `Executed proposal ${proposal.id} as workspace run ${execution.job.id}.`,
    queuedRunId: execution.job.id,
    run: (await getWorkspaceRun(execution.job.id)) || null,
    proposal: proposalForResponse(proposal)
  };
}

export async function cancelVoiceProposal(input: VoiceCancelInput) {
  const proposalId = sanitizeProposalId(input?.proposalId, 'proposalId');
  const reason = sanitizeSummary(input?.reason || 'Cancelled by operator.');
  const requestedBy = sanitizeProposalId(input?.requestedBy || 'hii.voice', 'requestedBy');
  const proposals = await readProposalsInFileOrder();
  const proposal = proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) throw new Error(`Proposal ${proposalId} not found.`);
  if (proposal.status === 'cancelled') {
    return {
      ok: true,
      message: `Proposal ${proposal.id} was already cancelled.`,
      proposal: proposalForResponse(proposal)
    };
  }
  if (proposal.status === 'executed') {
    throw new Error('Executed proposals cannot be cancelled.');
  }

  if (proposal.status === 'queued' && proposal.jobId) {
    const cancellation = await requestWorkspaceRunCancellation({
      id: proposal.jobId,
      requestedBy
    });
    if (!cancellation.queued && cancellation.terminal && cancellation.job.status === 'cancelled') {
      const terminal = await writeProposalStatus(proposal.id, 'cancelled', { lastError: reason });
      return {
        ok: true,
        message: `Voice proposal ${proposal.id} was already terminal and now marked cancelled.`,
        proposal: proposalForResponse(terminal ?? { ...proposal, status: 'cancelled' })
      };
    }
  }

  const cancelled = await writeProposalStatus(proposal.id, 'cancelled', { lastError: reason });
  await emitVoiceEvent({
    status: 'cancelled',
    summary: `Cancelled voice proposal ${proposal.id} by ${requestedBy}`,
    proposalId
  });

  return {
    ok: true,
    message: `Voice proposal ${proposal.id} cancelled.`,
    proposal: proposalForResponse(cancelled ?? { ...proposal, status: 'cancelled', lastError: reason })
  };
}
