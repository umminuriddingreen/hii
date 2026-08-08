/**
 * The Notch's ambient state model.
 *
 * The Notch is answering exactly one question: *what needs my attention right
 * now?* It was deciding that from a handful of independent booleans — busy,
 * listening, speechBusy, error, proposals.length, latestQueuedRunId — which
 * multiply into combinations nobody enumerated and which could contradict each
 * other. One explicit state removes those combinations entirely.
 *
 * Native window mechanics are deliberately untouched: positioning,
 * always-on-top, all-spaces behaviour, expansion, focus loss and the global
 * shortcut all stay in the Tauri layer, which works. This is only about what the
 * surface says and offers.
 *
 * Pure and storage-free, so both the Notch and its tests read the same rules.
 */

export type NotchState =
  | 'IDLE'
  | 'QUICK_CAPTURE'
  | 'CAPTURING'
  | 'LISTENING'
  | 'TRANSCRIBING'
  | 'INTERPRETING'
  | 'PROPOSAL_READY'
  | 'WAITING_FOR_APPROVAL'
  | 'QUEUED'
  | 'WORKING'
  | 'WAITING_FOR_USER'
  | 'COMPLETE'
  | 'ERROR';

export type NotchAction = {
  /** Machine name the surface dispatches. */
  id: string;
  label: string;
  /** Keyboard affordance, where one exists. */
  key?: string;
};

export type NotchPresentation = {
  state: NotchState;
  /** The single sentence. Never a list: the question has one answer. */
  message: string;
  /** The single obvious thing to do. Null when there is nothing to do. */
  primary: NotchAction | null;
  /** Available behind a reveal, never competing with the primary. */
  secondary: NotchAction[];
  /** Whether the surface should expand itself for this state. */
  expand: boolean;
  /** Milliseconds after which the surface collapses. Null means it stays. */
  collapseAfterMs: number | null;
  /** Whether focus should move into the surface. */
  takesFocus: boolean;
  /** What this state is about, for "return to it" navigation. */
  target: { kind: 'workspace' | 'run' | 'proposal' | 'object'; id: string } | null;
};

export type NotchInputs = {
  capturing: boolean;
  listening: boolean;
  transcribing: boolean;
  interpreting: boolean;
  quickCapture: boolean;
  error: string;
  /**
   * A proposal interpretation just produced, which the human has not been shown.
   *
   * Distinct from `pendingProposals` on purpose: "HII worked out what you meant"
   * and "this is waiting on your decision" are different moments, and collapsing
   * them means a freshly interpreted intent looks the same as one that has been
   * sitting unanswered.
   */
  unseenProposal: { id: string; summary: string } | null;
  /** Proposals already surfaced and waiting on the human. */
  pendingProposals: { id: string; summary: string }[];
  activeRun: { id: string; summary: string; status: string } | null;
  lastCompletedRun: { id: string; summary: string; satisfied: boolean } | null;
  /** Live workspace selection, from the ephemeral cross-window channel. */
  selection: { workspaceId: string; selectedNodeIds: string[] } | null;
};

/**
 * States ranked by how much they need a human.
 *
 * An error outranks work in progress; a decision waiting on a person outranks a
 * machine that is busy. This ordering is the whole policy — with it, "what needs
 * my attention" has one answer rather than several competing ones.
 */
const precedence: NotchState[] = [
  'ERROR',
  'WAITING_FOR_APPROVAL',
  'PROPOSAL_READY',
  'WAITING_FOR_USER',
  'LISTENING',
  'TRANSCRIBING',
  'INTERPRETING',
  'CAPTURING',
  'QUICK_CAPTURE',
  'WORKING',
  'QUEUED',
  'COMPLETE',
  'IDLE'
];

/** Which states may follow which. Anything else is a bug, not a transition. */
export const notchTransitions: Record<NotchState, NotchState[]> = {
  IDLE: ['QUICK_CAPTURE', 'CAPTURING', 'LISTENING', 'WORKING', 'QUEUED', 'PROPOSAL_READY', 'ERROR'],
  QUICK_CAPTURE: ['IDLE', 'INTERPRETING', 'ERROR'],
  CAPTURING: ['IDLE', 'LISTENING', 'INTERPRETING', 'ERROR'],
  LISTENING: ['TRANSCRIBING', 'CAPTURING', 'IDLE', 'ERROR'],
  TRANSCRIBING: ['INTERPRETING', 'IDLE', 'ERROR'],
  INTERPRETING: ['PROPOSAL_READY', 'QUEUED', 'IDLE', 'ERROR'],
  PROPOSAL_READY: ['WAITING_FOR_APPROVAL', 'QUEUED', 'IDLE', 'ERROR'],
  WAITING_FOR_APPROVAL: ['QUEUED', 'IDLE', 'ERROR'],
  QUEUED: ['WORKING', 'COMPLETE', 'ERROR', 'IDLE'],
  WORKING: ['WAITING_FOR_USER', 'COMPLETE', 'ERROR', 'IDLE'],
  WAITING_FOR_USER: ['WORKING', 'COMPLETE', 'ERROR', 'IDLE'],
  COMPLETE: ['IDLE', 'CAPTURING', 'LISTENING', 'QUICK_CAPTURE'],
  ERROR: ['IDLE', 'CAPTURING', 'LISTENING', 'QUICK_CAPTURE']
};

export function isValidNotchTransition(from: NotchState, to: NotchState) {
  return from === to || notchTransitions[from].includes(to);
}

function candidates(inputs: NotchInputs): NotchState[] {
  const found: NotchState[] = [];
  if (inputs.error) found.push('ERROR');
  if (inputs.pendingProposals.length) found.push('WAITING_FOR_APPROVAL');
  if (inputs.unseenProposal) found.push('PROPOSAL_READY');
  if (inputs.activeRun?.status === 'waiting') found.push('WAITING_FOR_USER');
  if (inputs.listening) found.push('LISTENING');
  if (inputs.transcribing) found.push('TRANSCRIBING');
  if (inputs.interpreting) found.push('INTERPRETING');
  if (inputs.capturing) found.push('CAPTURING');
  if (inputs.quickCapture) found.push('QUICK_CAPTURE');
  if (inputs.activeRun?.status === 'running') found.push('WORKING');
  if (inputs.activeRun?.status === 'queued') found.push('QUEUED');
  if (inputs.lastCompletedRun) found.push('COMPLETE');
  found.push('IDLE');
  return found;
}

export function notchState(inputs: NotchInputs): NotchState {
  const found = new Set(candidates(inputs));
  return precedence.find((state) => found.has(state)) ?? 'IDLE';
}

function selectionSuffix(inputs: NotchInputs) {
  const count = inputs.selection?.selectedNodeIds.length ?? 0;
  if (!count) return '';
  return ` · ${count} object${count === 1 ? '' : 's'} selected`;
}

/**
 * What the Notch shows for a state.
 *
 * One message and one action. Everything else goes behind the reveal, because a
 * surface that offers three equally weighted choices is asking the human to
 * decide what it should have decided.
 */
export function notchPresentation(inputs: NotchInputs): NotchPresentation {
  const state = notchState(inputs);
  const selection = selectionSuffix(inputs);

  switch (state) {
    case 'ERROR':
      return {
        state,
        message: inputs.error,
        primary: { id: 'dismiss-error', label: 'Dismiss', key: 'Esc' },
        secondary: [{ id: 'open-workspace', label: 'Open workspace' }],
        expand: true,
        // An error stays until it is acknowledged. Collapsing it would be HII
        // deciding the human had seen something they may not have.
        collapseAfterMs: null,
        takesFocus: true,
        target: inputs.activeRun ? { kind: 'run', id: inputs.activeRun.id } : null
      };

    case 'WAITING_FOR_APPROVAL': {
      const next = inputs.pendingProposals[0];
      const more = inputs.pendingProposals.length - 1;
      return {
        state,
        message: `${next.summary}${more > 0 ? ` · ${more} more waiting` : ''}`,
        primary: { id: 'approve', label: 'Approve', key: 'Enter' },
        secondary: [
          { id: 'cancel', label: 'Cancel', key: 'Esc' },
          ...(more > 0 ? [{ id: 'show-all', label: `Show ${more} more` }] : [])
        ],
        expand: true,
        collapseAfterMs: null,
        takesFocus: true,
        target: { kind: 'proposal', id: next.id }
      };
    }

    case 'PROPOSAL_READY':
      return {
        state,
        message: inputs.unseenProposal?.summary ?? 'Ready to propose an action.',
        primary: { id: 'review', label: 'Review', key: 'Enter' },
        secondary: [{ id: 'discard', label: 'Discard', key: 'Esc' }],
        expand: true,
        collapseAfterMs: null,
        takesFocus: true,
        target: null
      };

    case 'WAITING_FOR_USER':
      return {
        state,
        message: `${inputs.activeRun?.summary ?? 'A run'} needs you.`,
        primary: { id: 'open-run', label: 'Open run', key: 'Enter' },
        secondary: [{ id: 'cancel-run', label: 'Cancel run' }],
        expand: true,
        collapseAfterMs: null,
        takesFocus: true,
        target: inputs.activeRun ? { kind: 'run', id: inputs.activeRun.id } : null
      };

    case 'LISTENING':
      return {
        state,
        message: `Listening${selection}`,
        primary: { id: 'stop-listening', label: 'Stop', key: 'Esc' },
        secondary: [],
        expand: true,
        collapseAfterMs: null,
        takesFocus: true,
        target: inputs.selection ? { kind: 'workspace', id: inputs.selection.workspaceId } : null
      };

    case 'TRANSCRIBING':
      return {
        state,
        message: 'Transcribing…',
        primary: { id: 'stop-listening', label: 'Stop', key: 'Esc' },
        secondary: [],
        expand: true,
        collapseAfterMs: null,
        takesFocus: false,
        target: null
      };

    case 'INTERPRETING':
      return {
        state,
        message: 'Working out what you meant…',
        primary: null,
        secondary: [{ id: 'cancel', label: 'Cancel', key: 'Esc' }],
        expand: true,
        collapseAfterMs: null,
        takesFocus: false,
        target: null
      };

    case 'CAPTURING':
      return {
        state,
        message: `What do you want to do?${selection}`,
        primary: { id: 'submit', label: 'Send', key: 'Enter' },
        secondary: [
          { id: 'listen', label: 'Speak instead' },
          { id: 'dismiss', label: 'Close', key: 'Esc' }
        ],
        expand: true,
        collapseAfterMs: null,
        takesFocus: true,
        target: inputs.selection ? { kind: 'workspace', id: inputs.selection.workspaceId } : null
      };

    case 'QUICK_CAPTURE':
      return {
        state,
        message: 'Capture a thought.',
        primary: { id: 'submit', label: 'Save', key: 'Enter' },
        secondary: [{ id: 'dismiss', label: 'Close', key: 'Esc' }],
        expand: true,
        collapseAfterMs: null,
        takesFocus: true,
        target: null
      };

    case 'WORKING':
      return {
        state,
        message: inputs.activeRun?.summary ?? 'Working…',
        primary: { id: 'open-run', label: 'Open run' },
        secondary: [{ id: 'cancel-run', label: 'Cancel run' }],
        expand: false,
        // Progress does not need a human. It collapses so the Notch stops
        // occupying attention it does not need.
        collapseAfterMs: 4_000,
        takesFocus: false,
        target: inputs.activeRun ? { kind: 'run', id: inputs.activeRun.id } : null
      };

    case 'QUEUED':
      return {
        state,
        message: `Queued: ${inputs.activeRun?.summary ?? 'a run'}`,
        primary: { id: 'open-run', label: 'Open run' },
        secondary: [{ id: 'cancel-run', label: 'Cancel run' }],
        expand: false,
        collapseAfterMs: 4_000,
        takesFocus: false,
        target: inputs.activeRun ? { kind: 'run', id: inputs.activeRun.id } : null
      };

    case 'COMPLETE': {
      const run = inputs.lastCompletedRun!;
      return {
        state,
        message: run.satisfied
          ? `Done: ${run.summary}`
          : `${run.summary} did not meet its declared outcome.`,
        primary: { id: 'open-result', label: run.satisfied ? 'Show me' : 'See why' },
        secondary: [{ id: 'dismiss', label: 'Dismiss', key: 'Esc' }],
        expand: true,
        // A satisfied result can fade; an unmet outcome waits to be seen.
        collapseAfterMs: run.satisfied ? 6_000 : null,
        takesFocus: false,
        target: { kind: 'run', id: run.id }
      };
    }

    case 'IDLE':
    default:
      return {
        state: 'IDLE',
        message: inputs.selection?.selectedNodeIds.length
          ? `${inputs.selection.selectedNodeIds.length} object${inputs.selection.selectedNodeIds.length === 1 ? '' : 's'} selected`
          : 'HII',
        primary: { id: 'capture', label: 'Ask HII' },
        secondary: [],
        expand: false,
        collapseAfterMs: 0,
        takesFocus: false,
        target: inputs.selection ? { kind: 'workspace', id: inputs.selection.workspaceId } : null
      };
  }
}

export function emptyNotchInputs(): NotchInputs {
  return {
    capturing: false,
    listening: false,
    transcribing: false,
    interpreting: false,
    quickCapture: false,
    error: '',
    unseenProposal: null,
    pendingProposals: [],
    activeRun: null,
    lastCompletedRun: null,
    selection: null
  };
}
