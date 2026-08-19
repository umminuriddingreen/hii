import { describe, expect, it } from 'vitest';
import {
  agentTerminalSeedFromText,
  isDirectCanvasTyping,
  isTerminalShortcut,
  terminalSeedFromCommand
} from '../../lib/workspace/terminal-command';

describe('canvas terminal command', () => {
  it('creates a governed terminal object at the default HII folder', () => {
    expect(terminalSeedFromCommand('/terminal')).toMatchObject({
      type: 'terminal',
      w: 620,
      h: 320,
      object: {
        kind: 'terminal',
        owner: 'human',
        status: 'ready',
        capabilityId: 'hii.terminal.observe'
      },
      payload: {
        title: 'terminal · hii',
        job: 'local terminal',
        cwd: '~/hii',
        status: 'ready',
        role: 'operator-terminal',
        scope: 'local session · no command started'
      }
    });
  });

  it('uses the optional folder without executing it', () => {
    const seed = terminalSeedFromCommand('/terminal /Users/ummi/hii-newest');
    expect(seed?.payload).toMatchObject({
      title: 'terminal · hii-newest',
      cwd: '/Users/ummi/hii-newest'
    });
  });

  it('does not capture unrelated canvas intent', () => {
    expect(terminalSeedFromCommand('/terminally')).toBeNull();
    expect(terminalSeedFromCommand('build the app')).toBeNull();
  });

  it('opens from bare Space without capturing modifiers or key repeat', () => {
    const key = { code: 'Space', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false };
    expect(isTerminalShortcut(key)).toBe(true);
    expect(isTerminalShortcut({ ...key, metaKey: true })).toBe(false);
    expect(isTerminalShortcut({ ...key, shiftKey: true })).toBe(false);
    expect(isTerminalShortcut({ ...key, repeat: true })).toBe(false);
    expect(isTerminalShortcut({ ...key, code: 'KeyA' })).toBe(false);
  });

  it('turns direct canvas typing into an agent-bound terminal draft', () => {
    expect(agentTerminalSeedFromText('b', { mode: 'build', contextNodeIds: ['source-1', 'source-1'] })).toMatchObject({
      type: 'terminal',
      object: {
        kind: 'terminal',
        status: 'ready',
        capabilityId: 'hii.agent.workspace_run'
      },
      payload: {
        title: 'agent terminal · build',
        role: 'agent-terminal',
        mode: 'build',
        draft: 'b',
        contextNodeIds: ['source-1']
      }
    });
  });

  it('recognizes plain typed text without capturing shortcuts', () => {
    const key = { key: 'b', altKey: false, ctrlKey: false, metaKey: false };
    expect(isDirectCanvasTyping(key)).toBe(true);
    expect(isDirectCanvasTyping({ ...key, metaKey: true })).toBe(false);
    expect(isDirectCanvasTyping({ ...key, key: 'Enter' })).toBe(false);
    expect(isDirectCanvasTyping({ ...key, key: ' ' })).toBe(false);
  });
});
