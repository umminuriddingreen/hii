// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-memory-api-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function localRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('host', '127.0.0.1:3000');
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  return new Request(url, { ...init, headers });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

describe('HII memory API', () => {
  it('is reachable through the SvelteKit API dispatcher', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/routes/api/[...path]/+server.ts'), 'utf8');
    expect(source).toContain("import * as memory from '@/app/api/memory/route'");
    expect(source).toContain('{ pattern: /^memory$/, module: memory }');
  });

  it('keeps memory operations local-only', async () => {
    const route = await import('../../app/api/memory/route');
    const response = await route.GET(new Request('http://evil.example/api/memory', {
      headers: { host: 'evil.example', origin: 'http://evil.example' }
    }));
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: 'HII memory tools are local-only.' });
  });

  it('creates, reads, and patches bounded memory objects', async () => {
    const route = await import('../../app/api/memory/route');
    const create = await route.POST(localRequest('http://127.0.0.1:3000/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        spaceId: 'life',
        actorId: 'agent:codex',
        runId: 'run-1',
        input: {
          kind: 'task',
          title: 'Stay on track today',
          blocks: [{ type: 'check', text: 'Choose the next real action', checked: false }],
          idempotencyKey: 'today-track'
        }
      })
    }));
    expect(create.status).toBe(201);
    const created = await json(create);
    expect(created.object.properties.title).toBe('Stay on track today');

    const list = await route.GET(localRequest('http://127.0.0.1:3000/api/memory?spaceId=life'));
    expect((await json(list)).objects).toHaveLength(1);

    const patch = await route.POST(localRequest('http://127.0.0.1:3000/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        action: 'patch',
        spaceId: 'life',
        actorId: 'agent:codex',
        input: {
          id: created.targetId,
          baseVersion: 1,
          status: 'active'
        }
      })
    }));
    expect(patch.status).toBe(200);
    expect((await json(patch)).object.properties.status).toBe('active');
  });

  it('returns a conflict for stale concurrent patches', async () => {
    const route = await import('../../app/api/memory/route');
    const create = await route.POST(localRequest('http://127.0.0.1:3000/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        actorId: 'human:ummi',
        input: { kind: 'note', title: 'Concurrent life note' }
      })
    }));
    const created = await json(create);
    await route.POST(localRequest('http://127.0.0.1:3000/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        action: 'patch',
        actorId: 'agent:one',
        input: { id: created.targetId, baseVersion: 1, status: 'first' }
      })
    }));

    const stale = await route.POST(localRequest('http://127.0.0.1:3000/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        action: 'patch',
        actorId: 'agent:two',
        input: { id: created.targetId, baseVersion: 1, status: 'second' }
      })
    }));
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: 'stale-version' });
  });
});
