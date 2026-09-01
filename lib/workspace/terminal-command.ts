// SPDX-License-Identifier: LicenseRef-BSL-1.1

import type { NodeSeed } from './ingest';

const TERMINAL_COMMAND = /^\/terminal(?:\s+(.+))?$/i;
const DEFAULT_CWD = '~/hii';

export function isTerminalShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'repeat' | 'shiftKey'>) {
  return event.code === 'Space'
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !event.repeat;
}

/** Command-Space summons HII when available; Option-Space works with stock Spotlight settings. */
export function isAssistantShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'repeat' | 'shiftKey'>) {
  return event.code === 'Space'
    && !event.ctrlKey
    && !event.shiftKey
    && !event.repeat
    && ((event.metaKey && !event.altKey) || (event.altKey && !event.metaKey));
}

export function isDirectCanvasTyping(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey'>) {
  return !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && event.key.length === 1
    && Boolean(event.key.trim());
}

function cleanCwd(value?: string) {
  const cleaned = (value || DEFAULT_CWD)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 512);
  return cleaned || DEFAULT_CWD;
}

function cwdLabel(cwd: string) {
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1) || cwd;
}

/** Build a persistent terminal canvas object from the direct `/terminal [folder]` command. */
export function terminalSeedFromCommand(value: string): NodeSeed | null {
  const match = value.trim().match(TERMINAL_COMMAND);
  if (!match) return null;
  const cwd = cleanCwd(match[1]);
  return {
    type: 'terminal',
    w: 860,
    h: 480,
    object: {
      kind: 'terminal',
      owner: 'human',
      status: 'ready',
      source: 'HII direct canvas terminal command',
      capabilityId: 'hii.terminal.shell',
      audit: [{
        ts: new Date().toISOString(),
        actor: 'human',
        action: `created explicit native shell terminal at ${cwd}`
      }]
    },
    payload: {
      title: `terminal · ${cwdLabel(cwd)}`,
      job: 'shell',
      cwd,
      status: 'ready',
      role: 'operator-terminal',
      terminalMode: 'shell',
      windowState: 'normal',
      scope: 'human-controlled local shell',
      sessionId: crypto.randomUUID(),
      lines: []
    }
  };
}

/** Create the persistent objective draft used when the human starts typing directly on the canvas. */
export function objectiveSeedFromText(
  value: string,
  options: { mode?: string; contextNodeIds?: string[] } = {}
): NodeSeed {
  const mode = options.mode || 'build';
  const contextNodeIds = [...new Set(options.contextNodeIds || [])].slice(0, 100);
  return {
    type: 'intent',
    w: 620,
    h: 280,
    object: {
      kind: 'intent',
      owner: 'human',
      status: 'ready',
      source: 'HII direct canvas typing',
      capabilityId: 'hii.agent.workspace_run',
      audit: [{
        ts: new Date().toISOString(),
        actor: 'human',
        action: 'created a persistent objective draft'
      }]
    },
    payload: {
      title: `objective · ${mode}`,
      status: 'ready',
      role: 'agent-objective',
      mode,
      draft: value,
      text: '',
      contextNodeIds,
      contextCount: contextNodeIds.length,
      authority: `${mode} authority`,
      sessionId: crypto.randomUUID(),
      output: ''
    }
  };
}
