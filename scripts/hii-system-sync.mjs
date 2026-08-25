#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

const args = process.argv.slice(2);

function flag(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function collect(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function help() {
  console.log(`Usage:
  HII_SYSTEM_SYNC_KEY=... node --experimental-strip-types scripts/hii-system-sync.mjs \\
    --system-id mac --system-label "Studio Mac" --transport ssh --address 100.125.216.124 \\
    --session-id codex-agent --cwd /Users/ummi/hii --status running \\
    --job-id agent-job-1 --title "Codex agent on Mac" --line "running tests"

This records an observation-only system terminal object on the HII canvas.
It does not execute remote commands or store the raw sync key.`);
}

if (args.includes('--help') || args.includes('-h')) {
  help();
  process.exit(0);
}

const key = process.env.HII_SYSTEM_SYNC_KEY || '';
if (!key) {
  console.error('HII_SYSTEM_SYNC_KEY is required. Do not pass sync keys as command-line flags.');
  process.exit(2);
}

const { attachSystemSync } = await import('../lib/server/hii-system-sync.ts');

try {
  const result = await attachSystemSync(key, {
    workspaceId: flag('workspace-id'),
    system: {
      id: flag('system-id', 'system'),
      label: flag('system-label') || flag('system-id', 'system'),
      address: flag('address'),
      transport: flag('transport', 'manual')
    },
    terminal: {
      sessionId: flag('session-id', 'terminal'),
      title: flag('title'),
      cwd: flag('cwd', process.cwd()),
      status: flag('status', 'unknown'),
      lines: collect('line')
    },
    job: {
      id: flag('job-id'),
      title: flag('title'),
      status: flag('status', 'unknown'),
      proofRefs: collect('proof')
    }
  });
  console.log(JSON.stringify({
    ok: true,
    nodeId: result.nodeId,
    workspaceRevision: result.workspace.revision,
    systemId: result.system.id,
    terminalId: result.terminal.id
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
