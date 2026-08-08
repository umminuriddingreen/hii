import type { WorkspaceRunContextItem } from '@/lib/server/hii-workspace-run-context';

export type VoiceIntentMode = 'dictate' | 'ask' | 'edit' | 'navigate' | 'act' | 'uncertain';

export type ReferenceSource = 'POINTER' | 'SELECTION' | 'SCREEN' | 'MEMORY' | 'DISCOURSE';

export interface ResolvedReference {
  source: ReferenceSource;
  objectId: string;
  application?: string;
  confidence: number;
  timestamp: string;
  contextHint?: string;
}

/**
 * How the audio for an utterance was actually processed.
 *
 * `browser-managed` covers the Web Speech API, where the browser may forward
 * audio to a platform service. It is not a local-only guarantee and must never
 * be presented as one.
 */
export type SpeechProcessing = 'local-native' | 'browser-managed' | 'external-provider' | 'unknown';

/** Where in the workspace an utterance was spoken, resolved against the persisted document. */
export interface VoiceWorkspaceContextSnapshot {
  workspaceId: string;
  workspaceRevision: number;
  available: boolean;
  selectedNodeIds: string[];
  unresolvedNodeIds: string[];
  sceneId?: string;
  sceneTitle?: string;
  notice: string;
}

export interface ContextSnapshot {
  snapshotAt: string;
  activeApp?: string;
  activeWindow?: string;
  selectedText?: string;
  conversationTurn?: string;
  projectPath?: string;
  platform: 'mac' | 'windows' | 'linux' | 'unknown';
  recentCommandSummary?: string;
  voices?: string[];
  references?: ResolvedReference[];
  speechProcessing?: SpeechProcessing;
  workspace?: VoiceWorkspaceContextSnapshot;
}

export interface CapabilityInvocation {
  capabilityId: string;
  purpose: string;
  inputs: Record<string, unknown>;
  expectedOutputs?: string[];
  requiresApproval: boolean;
}

export interface VoiceIntent {
  utterance: string;
  normalizedText?: string;
  mode: VoiceIntentMode;
  confidence: number;
  context: ContextSnapshot;
  references: ResolvedReference[];
  backtrack?: {
    original: string;
    final: string;
  };
  correctionHint?: string;
  proposedAction?: CapabilityInvocation;
  approvalRequired: boolean;
}

export interface VoiceProposal {
  id: string;
  contextSnapshot: ContextSnapshot;
  utterance: string;
  normalizedText: string;
  mode: VoiceIntentMode;
  confidence: number;
  purpose: string;
  capabilityId: string;
  inputs: Record<string, unknown>;
  createdAt: string;
  status: 'pending' | 'queued' | 'executed' | 'failed' | 'cancelled';
  /**
   * Context entries resolved from the workspace at capture time. Carried on the
   * proposal so approval executes the context the human reviewed, not an empty
   * set rebuilt at execution time.
   */
  context?: WorkspaceRunContextItem[];
  workspaceRoot?: string;
  lastError?: string;
  jobId?: string;
  receipts?: string[];
  approvedAt?: string;
  updatedAt?: string;
}

export type VoiceRuntimeEngine = {
  id: string;
  name: string;
  transport: 'local-browser' | 'server-stream';
  /**
   * Proven transport classification. HII does not control what a browser does
   * with captured audio, so anything short of a local native recognizer is
   * reported as browser-managed rather than local-only.
   */
  speechProcessing: SpeechProcessing;
  privacyNotice: string;
  modelProfile?: string;
  ready: boolean;
  latencyHint: string;
};

export interface VoiceInterpretInput {
  utterance: string;
  platform?: string;
  model?: string;
  requestedBy?: string;
  requireApproval?: boolean;
  references?: ResolvedReference[];
  /**
   * The workspace selection the speaker had active. Claims here are resolved
   * against the persisted workspace before they become context.
   */
  workspace?: {
    workspaceId?: string;
    nodeIds?: string[];
    sceneId?: string;
    selectedText?: string;
  };
}

export interface VoiceExecutionInput {
  proposalId: string;
  requestedBy?: string;
}

export interface VoiceCancelInput {
  proposalId: string;
  reason?: string;
  requestedBy?: string;
}

export interface VoiceProposalExecutionResult {
  ok: boolean;
  message: string;
  queuedRunId?: string;
  run?: unknown;
  proposal?: VoiceProposal;
}

export interface VoiceRuntimeState {
  intent: VoiceIntent;
  proposalId?: string;
  queuedRunId?: string;
  queuedRun?: unknown;
  actionDescription?: string;
  requiresUserAction: boolean;
  message: string;
}
