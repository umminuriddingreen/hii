// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let runtimeDir = '';
const key = 'correct horse battery staple for systems';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-system-sync-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const { resetOperationalObjectStoreForTests } = await import('../../lib/server/operational-object-store');
  resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe('HII system sync', () => {
  it('rejects weak sync keys and never stores the raw key', async () => {
    const sync = await import('../../lib/server/hii-system-sync');
    await expect(sync.attachSystemSync('short', {
      system: { id: 'mac', label: 'Mac' },
      terminal: { sessionId: 'agent', cwd: '/Users/ummi/hii' }
    })).rejects.toThrow(/20 to 512/);

    await sync.attachSystemSync(key, {
      system: { id: 'mac', label: 'Mac', address: '100.125.216.124', transport: 'ssh' },
      terminal: { sessionId: 'agent', cwd: '/Users/ummi/hii', status: 'running' }
    });

    const files = await readdir(path.join(runtimeDir, 'system-sync'));
    const stored = await readFile(path.join(runtimeDir, 'system-sync', files[0]), 'utf8');
    expect(stored).not.toContain(key);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('upserts a governed terminal object onto the HII workspace', async () => {
    const sync = await import('../../lib/server/hii-system-sync');
    const first = await sync.attachSystemSync(key, {
      system: { id: 'mac', label: 'Studio Mac', address: '100.125.216.124', transport: 'ssh' },
      terminal: {
        sessionId: 'codex-agent',
        title: 'Codex agent on Mac',
        cwd: '/Users/ummi/hii',
        status: 'running',
        lines: ['cargo test -p hii-cli', 'running 42 tests']
      },
      job: { id: 'agent-job-1', title: 'sync HII canvas', status: 'running', proofRefs: ['ssh://mac/~/.hii/runs/job/receipt.json'] }
    });

    expect(first.workspace.nodes).toHaveLength(1);
    expect(first.workspace.nodes[0]).toMatchObject({
      id: first.nodeId,
      type: 'terminal',
      object: {
        kind: 'terminal',
        owner: 'mac',
        status: 'running',
        capabilityId: 'hii.system.sync',
        runId: 'agent-job-1'
      },
      payload: {
        title: 'Codex agent on Mac',
        cwd: '/Users/ummi/hii',
        role: 'system-terminal',
        systemAddress: '100.125.216.124',
        transport: 'ssh'
      }
    });
    expect(first.workspace.nodes[0].payload.lines).toEqual(['cargo test -p hii-cli', 'running 42 tests']);

    const second = await sync.attachSystemSync(key, {
      system: { id: 'mac', label: 'Studio Mac', address: '100.125.216.124', transport: 'ssh' },
      terminal: {
        sessionId: 'codex-agent',
        title: 'Codex agent on Mac',
        cwd: '/Users/ummi/hii',
        status: 'completed',
        lines: ['receipt written']
      },
      job: { id: 'agent-job-1', proofRefs: ['ssh://mac/~/.hii/runs/job/receipt.json'] }
    });

    expect(second.workspace.nodes).toHaveLength(1);
    expect(second.workspace.nodes[0].object?.status).toBe('completed');
    expect(second.workspace.nodes[0].payload.lines).toEqual(['receipt written']);
    expect(second.workspace.revision).toBeGreaterThan(first.workspace.revision);
  });

  it('serializes concurrent systems without dropping either canvas object', async () => {
    const sync = await import('../../lib/server/hii-system-sync');
    await Promise.all([
      sync.attachSystemSync(key, {
        system: { id: 'mac', label: 'Mac', transport: 'ssh' },
        terminal: { sessionId: 'agent', cwd: '/Users/ummi/hii', status: 'running' }
      }),
      sync.attachSystemSync(key, {
        system: { id: 'pc', label: 'PC', transport: 'local' },
        terminal: { sessionId: 'agent', cwd: 'C:\\Users\\ummin\\hii', status: 'running' }
      })
    ]);

    const store = await import('../../lib/server/workspace-store');
    const workspace = await store.readWorkspace();
    expect(workspace.nodes.map((node) => node.payload.systemId).sort()).toEqual(['mac', 'pc']);
  });
});
