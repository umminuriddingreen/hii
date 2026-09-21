import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  objectiveSeedFromText,
  isAssistantShortcut,
  isDirectCanvasTyping,
  isTerminalShortcut,
  terminalSeedFromCommand
} from '../../lib/workspace/terminal-command';

describe('canvas terminal command', () => {
  it('creates a governed terminal object at the default HII folder', () => {
    expect(terminalSeedFromCommand('/terminal')).toMatchObject({
      type: 'terminal',
      w: 860,
      h: 480,
      object: {
        kind: 'terminal',
        owner: 'human',
        status: 'ready',
        capabilityId: 'hii.terminal.shell'
      },
      payload: {
        title: 'HII · hii',
        job: 'shell',
        cwd: '~/hii',
        status: 'ready',
        role: 'operator-terminal',
        terminalMode: 'shell',
        terminalEntry: 'hii',
        terminalPresentation: 'canvas',
        singletonKey: 'workspace-terminal',
        windowState: 'normal',
        scope: 'human-controlled local shell'
      }
    });
  });

  it('uses the optional folder without executing it', () => {
    const seed = terminalSeedFromCommand('/terminal /Users/ummi/hii-newest');
    expect(seed?.payload).toMatchObject({
      title: 'HII · hii-newest',
      cwd: '/Users/ummi/hii-newest'
    });
  });

  it('does not capture unrelated canvas intent', () => {
    expect(terminalSeedFromCommand('/terminally')).toBeNull();
    expect(terminalSeedFromCommand('build the app')).toBeNull();
  });

  it('moves the canonical terminal with Command-Shift-T without capturing bare Space', () => {
    const key = { code: 'KeyT', altKey: false, ctrlKey: false, metaKey: true, shiftKey: true, repeat: false };
    expect(isTerminalShortcut(key)).toBe(true);
    expect(isTerminalShortcut({ ...key, metaKey: false })).toBe(false);
    expect(isTerminalShortcut({ ...key, shiftKey: false })).toBe(false);
    expect(isTerminalShortcut({ ...key, repeat: true })).toBe(false);
    expect(isTerminalShortcut({ ...key, code: 'Space' })).toBe(false);
  });

  it('summons the contextual HII assistant with Command-Space only', () => {
    const key = { code: 'Space', altKey: false, ctrlKey: false, metaKey: true, shiftKey: false, repeat: false };
    expect(isAssistantShortcut(key)).toBe(true);
    expect(isAssistantShortcut({ ...key, metaKey: false, altKey: true })).toBe(true);
    expect(isAssistantShortcut({ ...key, metaKey: false })).toBe(false);
    expect(isAssistantShortcut({ ...key, ctrlKey: true })).toBe(false);
    expect(isAssistantShortcut({ ...key, altKey: true })).toBe(false);
    expect(isAssistantShortcut({ ...key, shiftKey: true })).toBe(false);
    expect(isAssistantShortcut({ ...key, repeat: true })).toBe(false);
  });

  it('renders Command-Space as the canonical workspace terminal', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(root).toContain('isAssistantShortcut(event)');
    expect(root).toContain("ensureWorkspaceTerminal('docked')");
    expect(root).toContain("singletonKey: 'workspace-terminal'");
    expect(css).toContain('.hii-docked-terminal');
    expect(root).not.toContain('Make presentation');
  });

  it('keeps Command-K for the information terminal and Command-Space for the PTY', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(root).toContain("event.key.toLowerCase() === 'k'");
    expect(root).toContain('setCanvasCommandsOpen((open) => !open)');
    expect(root).toContain("ensureWorkspaceTerminal('docked')");
    expect(root).toContain("presentation: 'canvas' | 'docked' | 'quick'");
    expect(root).toContain('onKeyDownCapture={(event) => {');
    expect(css).toContain('height: min(42vh, 300px);');
  });

  it('turns Command-T search text into a live browser object on the canvas', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(root).toContain('aria-label="Write a web search on the canvas"');
    expect(root).toContain('className="hii-canvas-search-text"');
    expect(root).toContain("event.key.toLowerCase() === 't'");
    expect(root).toContain('openDevBrowser({ x: center.x - 540, y: center.y - 360 }, query)');
    expect(root).toContain('Opened web results for “${query}”.');
    expect(css).toContain('.hii-canvas-search-text input');
    expect(css).toContain('background: transparent');
  });

  it('turns direct canvas typing into a persistent objective draft', () => {
    expect(objectiveSeedFromText('b', { mode: 'build', contextNodeIds: ['source-1', 'source-1'] })).toMatchObject({
      type: 'intent',
      object: {
        kind: 'intent',
        status: 'ready',
        capabilityId: 'hii.agent.workspace_run'
      },
      payload: {
        title: 'objective · build',
        role: 'agent-objective',
        mode: 'build',
        draft: 'b',
        contextNodeIds: ['source-1']
      }
    });
  });

  it('queues account work for the linked native executor without browser shell authority', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    expect(root).toContain("status: 'queued'");
    expect(root).toContain("requestedBy: creatorId");
    expect(root).toContain("queued bounded work for a linked HII executor");
    expect(root).toContain("node.payload.status !== 'queued'");
    expect(root).toContain("startObjectiveAgent(node.id, text(node.payload.text) || text(node.payload.draft))");
    expect(root).toContain("No browser shell access was granted.");
    expect(root).toContain("onStartWork={runtimeEnabled ? startFromCommand : isAccount && spaceId ? queueAccountObjective : undefined}");
    expect(root).toContain('bufferedAgentEvents.current.set(event.runId');
    expect(root).toContain('for (const event of buffered) applyObjectiveAgentEvent(nodeId, event)');
  });

  it('routes direct workspace typing into editable canvas text', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    expect(root).toContain('spawnSeeds([canvasTextSeed(event.key)], at)');
    expect(root).not.toContain('objectiveSeedFromText(event.key, { mode, contextNodeIds: selected })');
  });

  it('recognizes plain typed text without capturing shortcuts', () => {
    const key = { key: 'b', altKey: false, ctrlKey: false, metaKey: false };
    expect(isDirectCanvasTyping(key)).toBe(true);
    expect(isDirectCanvasTyping({ ...key, metaKey: true })).toBe(false);
    expect(isDirectCanvasTyping({ ...key, key: 'Enter' })).toBe(false);
    expect(isDirectCanvasTyping({ ...key, key: ' ' })).toBe(false);
  });

  it('renders functional macOS-style terminal window controls inside the canvas node', () => {
    const frame = readFileSync(resolve(process.cwd(), 'components/workspace/NodeFrame.tsx'), 'utf8');
    expect(frame).toContain('className="hii-terminal-window-controls"');
    expect(frame).toContain('role="group"');
    expect(frame).toContain('aria-label={`Close ${title}`}');
    expect(frame).toContain('aria-label={windowState === \'minimized\' ? `Restore ${title}` : `Minimize ${title}`}');
    expect(frame).toContain('aria-label={windowState === \'maximized\' ? `Restore ${title}` : `Maximize ${title}`}');
    expect(frame).toContain('className="hii-terminal-resize"');
    expect(frame).toContain("onWindowAction?.(windowState === 'maximized' ? 'restore' : 'maximize')");
  });

  it('keeps the terminal chrome visibly tied to the reference palette', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toContain('.hii-terminal-close { background: #ff5f57; }');
    expect(css).toContain('.hii-terminal-minimize { background: #febc2e; }');
    expect(css).toContain('.hii-terminal-maximize { background: #28c840; }');
    expect(css).toContain('.hii-job-terminal[data-kind="shell"]');
  });

  it('stops a native shell session when its terminal node is deleted', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    expect(root).toContain('stopTerminalSession(sessionId)');
    expect(root).toContain('onErase={() => { removeWorkspaceNode(node);');
  });
});
