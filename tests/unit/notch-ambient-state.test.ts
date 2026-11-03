import { describe, expect, it } from 'vitest';
import {
  emptyNotchInputs,
  isValidNotchTransition,
  notchPresentation,
  notchState,
  notchTransitions,
  type NotchInputs,
  type NotchState
} from '../../lib/notch/ambient-state';

function inputs(overrides: Partial<NotchInputs> = {}): NotchInputs {
  return { ...emptyNotchInputs(), ...overrides };
}

const allStates: NotchState[] = [
  'IDLE',
  'QUICK_CAPTURE',
  'CAPTURING',
  'LISTENING',
  'TRANSCRIBING',
  'INTERPRETING',
  'PROPOSAL_READY',
  'WAITING_FOR_APPROVAL',
  'QUEUED',
  'WORKING',
  'WAITING_FOR_USER',
  'COMPLETE',
  'ERROR'
];

describe('notch ambient state', () => {
  it('resolves to exactly one state', () => {
    expect(notchState(inputs())).toBe('IDLE');
    expect(notchState(inputs({ listening: true }))).toBe('LISTENING');
    expect(notchState(inputs({ activeRun: { id: 'r', summary: 's', status: 'running' } }))).toBe('WORKING');
  });

  it('puts what needs a human ahead of what does not', () => {
    // Several things are true at once. The answer is still one thing.
    const busy = inputs({
      listening: true,
      interpreting: true,
      activeRun: { id: 'r', summary: 'building', status: 'running' },
      pendingProposals: [{ id: 'p1', summary: 'Delete the staging branch' }]
    });
    expect(notchState(busy)).toBe('WAITING_FOR_APPROVAL');

    // An error outranks even a decision, because a broken thing invalidates it.
    expect(notchState({ ...busy, error: 'Ollama is not reachable.' })).toBe('ERROR');
  });

  it('gives every state one message and at most one primary action', () => {
    for (const state of allStates) {
      const shaped = shapeFor(state);
      const presentation = notchPresentation(shaped);
      expect(presentation.state, state).toBe(state);
      expect(presentation.message.length, state).toBeGreaterThan(0);
      expect(presentation.message.includes('\n'), state).toBe(false);
      expect(Array.isArray(presentation.secondary), state).toBe(true);
    }
  });

  it('keeps states that need attention open, and lets progress fade', () => {
    expect(notchPresentation(inputs({ error: 'broke' })).collapseAfterMs).toBeNull();
    expect(
      notchPresentation(inputs({ pendingProposals: [{ id: 'p', summary: 'do it' }] })).collapseAfterMs
    ).toBeNull();
    // Progress does not need a human.
    expect(
      notchPresentation(inputs({ activeRun: { id: 'r', summary: 'working', status: 'running' } }))
        .collapseAfterMs
    ).toBe(4_000);
  });

  it('lets a satisfied result fade but keeps an unmet outcome visible', () => {
    const done = notchPresentation(
      inputs({ lastCompletedRun: { id: 'r', summary: 'Wrote the note', satisfied: true } })
    );
    expect(done.collapseAfterMs).toBe(6_000);
    expect(done.message).toContain('Done:');

    const unmet = notchPresentation(
      inputs({ lastCompletedRun: { id: 'r', summary: 'Wrote the note', satisfied: false } })
    );
    expect(unmet.collapseAfterMs).toBeNull();
    expect(unmet.message).toContain('did not meet its declared outcome');
    expect(unmet.primary?.label).toBe('See why');
  });

  it('takes focus only where the human is expected to act', () => {
    expect(notchPresentation(inputs({ error: 'broke' })).takesFocus).toBe(true);
    expect(
      notchPresentation(inputs({ pendingProposals: [{ id: 'p', summary: 'x' }] })).takesFocus
    ).toBe(true);
    expect(
      notchPresentation(inputs({ activeRun: { id: 'r', summary: 'x', status: 'running' } })).takesFocus
    ).toBe(false);
    expect(notchPresentation(inputs({ interpreting: true })).takesFocus).toBe(false);
  });

  it('names what each state is about so the human can return to it', () => {
    expect(
      notchPresentation(inputs({ activeRun: { id: 'run-9', summary: 'x', status: 'running' } })).target
    ).toEqual({ kind: 'run', id: 'run-9' });
    expect(
      notchPresentation(inputs({ pendingProposals: [{ id: 'p-2', summary: 'x' }] })).target
    ).toEqual({ kind: 'proposal', id: 'p-2' });
    expect(
      notchPresentation(
        inputs({ capturing: true, selection: { workspaceId: 'default', selectedNodeIds: ['a'] } })
      ).target
    ).toEqual({ kind: 'workspace', id: 'default' });
  });

  it('reflects the live cross-window selection without holding any of its content', () => {
    const presentation = notchPresentation(
      inputs({
        capturing: true,
        selection: { workspaceId: 'default', selectedNodeIds: ['node-zebra', 'node-quartz'] }
      })
    );
    expect(presentation.message).toBe('What do you want to do? · 2 objects selected');
    expect(
      notchPresentation(inputs({ selection: { workspaceId: 'default', selectedNodeIds: ['node-zebra'] } }))
        .message
    ).toBe('1 object selected');
    // Nothing but a count: the ids resolve server-side against the workspace.
    expect(presentation.message).not.toContain('zebra');
    expect(presentation.message).not.toContain('quartz');
  });

  it('separates a freshly interpreted proposal from one already waiting', () => {
    expect(notchState(inputs({ unseenProposal: { id: 'p', summary: 'x' } }))).toBe('PROPOSAL_READY');
    // Once it has been surfaced, an unanswered decision outranks a new one.
    expect(
      notchState(
        inputs({ unseenProposal: { id: 'p2', summary: 'y' }, pendingProposals: [{ id: 'p1', summary: 'x' }] })
      )
    ).toBe('WAITING_FOR_APPROVAL');
  });

  it('declares transitions explicitly and rejects ones that are not', () => {
    expect(isValidNotchTransition('IDLE', 'LISTENING')).toBe(true);
    expect(isValidNotchTransition('LISTENING', 'TRANSCRIBING')).toBe(true);
    expect(isValidNotchTransition('TRANSCRIBING', 'INTERPRETING')).toBe(true);
    expect(isValidNotchTransition('INTERPRETING', 'WAITING_FOR_APPROVAL')).toBe(false);
    // Every state can be left, and every state can be reached.
    for (const state of allStates) {
      expect(notchTransitions[state].length, state).toBeGreaterThan(0);
      expect(
        allStates.some((other) => other !== state && notchTransitions[other].includes(state)),
        state
      ).toBe(true);
    }
  });

  it('always offers a way out of an error and a way back to idle', () => {
    const error = notchPresentation(inputs({ error: 'Ollama is not reachable.' }));
    expect(error.primary?.id).toBe('dismiss-error');
    expect(error.primary?.key).toBe('Esc');
    expect(notchTransitions.ERROR).toContain('IDLE');
  });
});

function shapeFor(state: NotchState): NotchInputs {
  switch (state) {
    case 'ERROR':
      return inputs({ error: 'something broke' });
    case 'WAITING_FOR_APPROVAL':
      return inputs({ pendingProposals: [{ id: 'p', summary: 'Do the thing' }] });
    case 'PROPOSAL_READY':
      return inputs({ unseenProposal: { id: 'p', summary: 'Rewrite the launch note' } });
    case 'WAITING_FOR_USER':
      return inputs({ activeRun: { id: 'r', summary: 'needs input', status: 'waiting' } });
    case 'LISTENING':
      return inputs({ listening: true });
    case 'TRANSCRIBING':
      return inputs({ transcribing: true });
    case 'INTERPRETING':
      return inputs({ interpreting: true });
    case 'CAPTURING':
      return inputs({ capturing: true });
    case 'QUICK_CAPTURE':
      return inputs({ quickCapture: true });
    case 'WORKING':
      return inputs({ activeRun: { id: 'r', summary: 'working', status: 'running' } });
    case 'QUEUED':
      return inputs({ activeRun: { id: 'r', summary: 'queued', status: 'queued' } });
    case 'COMPLETE':
      return inputs({ lastCompletedRun: { id: 'r', summary: 'done', satisfied: true } });
    default:
      return inputs();
  }
}
