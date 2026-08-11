// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationActor } from '../../lib/operational-graph/types';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-memory-workspace-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

const human: MutationActor = { actorId: 'human:ummi', deviceId: 'macbook' };
const agent: MutationActor = { actorId: 'agent:codex', runId: 'run-1', intentId: 'intent-1' };

async function memory() {
  return import('../../lib/server/hii-memory-workspace');
}

describe('HII memory workspace', () => {
  it('stores memory as typed graph objects instead of markdown files', async () => {
    const { createMemoryObject, readMemoryWorkspace } = await memory();
    const created = createMemoryObject('life', human, {
      kind: 'decision',
      title: 'Object memory is canonical',
      tags: ['hii', 'memory', 'hii'],
      blocks: [{ type: 'text', text: 'Markdown is an import/export surface, not the source of truth.' }],
      sourceRefs: [{ system: 'conversation', receiptId: 'turn-1' }]
    });

    expect(created.applied).toBe(true);
    expect(created.object).toMatchObject({
      type: 'memory.decision',
      canonicalSource: 'graph',
      provenanceClass: 'authored',
      properties: {
        kind: 'decision',
        title: 'Object memory is canonical',
        tags: ['hii', 'memory']
      }
    });

    const snapshot = readMemoryWorkspace('life');
    expect(snapshot.objects).toHaveLength(1);
    expect(snapshot.objects[0].properties.blocks).toEqual([
      { type: 'text', text: 'Markdown is an import/export surface, not the source of truth.' }
    ]);
  });

  it('replays idempotent writes without duplicating memories', async () => {
    const { createMemoryObject, readMemoryWorkspace } = await memory();
    const input = {
      kind: 'task' as const,
      title: 'Keep today on track',
      blocks: [{ type: 'check' as const, text: 'Pick one next action', checked: false }],
      idempotencyKey: 'today-task'
    };
    const first = createMemoryObject('life', human, input);
    const replay = createMemoryObject('life', human, input);

    expect(first.applied).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.targetId).toBe(first.targetId);
    expect(readMemoryWorkspace('life').objects).toHaveLength(1);
  });

  it('rejects stale concurrent patches so agents do not overwrite unseen work', async () => {
    const { createMemoryObject, patchMemoryObject } = await memory();
    const created = createMemoryObject('default', human, {
      kind: 'note',
      title: 'Concurrent memory',
      blocks: [{ type: 'text', text: 'base' }]
    });
    const id = created.targetId!;

    const first = patchMemoryObject('default', agent, {
      id,
      baseVersion: 1,
      blocks: [{ type: 'text', text: 'agent one saw version one' }]
    });
    expect(first.resultVersion).toBe(2);

    expect(() =>
      patchMemoryObject('default', { ...agent, runId: 'run-2' }, {
        id,
        baseVersion: 1,
        blocks: [{ type: 'text', text: 'agent two also saw version one' }]
      })
    ).toThrow(/changed since this mutation was decided/);
  });

  it('links memories with typed relations inside the same bounded workspace', async () => {
    const { createMemoryObject, relateMemoryObjects, readMemoryWorkspace } = await memory();
    const project = createMemoryObject('default', human, { kind: 'project', title: 'HII' });
    const skill = createMemoryObject('default', agent, {
      kind: 'skill',
      title: 'Preserve concurrent work',
      blocks: [{ type: 'text', text: 'Inspect git status and scoped diffs before editing.' }]
    });

    const relation = relateMemoryObjects('default', agent, {
      type: 'USES',
      fromObjectId: project.targetId!,
      toObjectId: skill.targetId!,
      label: 'workspace discipline'
    });

    expect(relation.applied).toBe(true);
    expect(readMemoryWorkspace('default').relations).toEqual([
      expect.objectContaining({
        type: 'USES',
        fromObjectId: project.targetId,
        toObjectId: skill.targetId,
        properties: { label: 'workspace discipline' }
      })
    ]);
  });
});
