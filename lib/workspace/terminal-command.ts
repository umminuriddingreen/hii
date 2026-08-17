// SPDX-License-Identifier: LicenseRef-BSL-1.1

import type { NodeSeed } from './ingest';

const TERMINAL_COMMAND = /^\/terminal(?:\s+(.+))?$/i;
const DEFAULT_CWD = '~/hii';

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
    w: 620,
    h: 320,
    object: {
      kind: 'terminal',
      owner: 'human',
      status: 'ready',
      source: 'HII direct canvas terminal command',
      capabilityId: 'hii.terminal.observe',
      audit: [{
        ts: new Date().toISOString(),
        actor: 'human',
        action: `created local terminal at ${cwd}`
      }]
    },
    payload: {
      title: `terminal · ${cwdLabel(cwd)}`,
      job: 'local terminal',
      cwd,
      status: 'ready',
      role: 'operator-terminal',
      scope: 'local session · no command started',
      sessionId: crypto.randomUUID(),
      lines: ['HII terminal object', 'Type an intent on the canvas to start verified work.']
    }
  };
}
