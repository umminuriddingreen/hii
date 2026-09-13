// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';
let workspaceRoot = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-variant-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-variant-root-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

const declared = { completed: true, legacy: false, proofStrength: 'declared', reasons: [] };
const incidental = { completed: true, legacy: false, proofStrength: 'incidental', reasons: [] };
const failed = {
  completed: false,
  legacy: false,
  proofStrength: 'declared',
  reasons: ['Required artifact missing: variant.md']
};

function workspace(): WorkspaceDoc {
  return {
    version: 1,
    revision: 0,
    updatedAt: '2026-08-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 2,
    nodes: [
      {
        id: 'source-1',
        type: 'note',
        x: 100,
        y: 200,
        w: 300,
        h: 180,
        z: 1,
        createdAt: '2026-08-08T09:00:00.000Z',
        updatedAt: '2026-08-08T09:00:00.000Z',
        payload: { title: 'Launch note', content: 'HII ships when the trust loop closes.' }
      }
    ],
    links: []
  };
}

async function seed() {
  const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
  const initial = await loadWorkspace();
  return writeWorkspace(workspace(), initial.workspace.revision);
}

async function proposal(instruction = 'Make it shorter and warmer.') {
  const { prepareVariantBranch } = await import('../../lib/server/workspace-variant');
  return prepareVariantBranch({
    workspaceId: 'default',
    sourceNodeId: 'source-1',
    instruction,
    medium: 'text'
  });
}

async function writeArtifact(relative: string, body = 'A shorter, warmer launch note.') {
  const target = path.join(workspaceRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  return target;
}

describe('preparing a variant branch', () => {
  it('produces a reviewable proposal without creating anything', async () => {
    await seed();
    const prepared = await proposal();
    expect(prepared.sourceNodeId).toBe('source-1');
    expect(prepared.sourceTitle).toBe('Launch note');
    expect(prepared.declaredOutcome).toEqual({
      kind: 'file-artifact',
      artifacts: [prepared.requiredArtifact]
    });
    expect(prepared.manifest.entries[0].excerpt).toBe('HII ships when the trust loop closes.');
    expect(prepared.manifest.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Beside the source, not on top of it.
    expect(prepared.placement).toEqual({ x: 448, y: 200, w: 300, h: 180 });

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    expect((await loadWorkspace()).workspace.nodes).toHaveLength(1);
  });

  it('refuses a medium HII cannot actually produce', async () => {
    await seed();
    const { prepareVariantBranch } = await import('../../lib/server/workspace-variant');
    await expect(
      prepareVariantBranch({
        workspaceId: 'default',
        sourceNodeId: 'source-1',
        instruction: 'Make it a song.',
        medium: 'audio'
      })
    ).rejects.toThrow(/not supported for "audio" yet/);
  });

  it('refuses an empty instruction and a missing source', async () => {
    await seed();
    const { prepareVariantBranch } = await import('../../lib/server/workspace-variant');
    await expect(
      prepareVariantBranch({ workspaceId: 'default', sourceNodeId: 'source-1', instruction: '', medium: 'text' })
    ).rejects.toThrow(/how the variant should differ/);
    await expect(
      prepareVariantBranch({ workspaceId: 'default', sourceNodeId: 'ghost', instruction: 'x y z', medium: 'text' })
    ).rejects.toThrow(/Select an object/);
  });

  // Windows CI can spend over five seconds on the cold SQLite/module setup.
  it('states the goal the run receives, including not touching the source', async () => {
    await seed();
    const { variantRunGoal } = await import('../../lib/server/workspace-variant');
    const goal = variantRunGoal(await proposal());
    expect(goal).toContain('Make it shorter and warmer.');
    expect(goal).toContain('Do not modify the source.');
  }, 15_000);
});

describe('materializing a variant branch', () => {
  it('creates the variant beside the source and preserves the original', async () => {
    await seed();
    const prepared = await proposal();
    await writeArtifact(prepared.requiredArtifact);
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const outcome = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: '/tmp/receipt.json',
      workspaceRoot,
      completion: declared
    });
    expect(outcome.materialized).toBe(true);
    if (!outcome.materialized) return;

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    const doc = (await loadWorkspace()).workspace;
    expect(doc.nodes).toHaveLength(2);
    const source = doc.nodes.find((node) => node.id === 'source-1')!;
    const variant = doc.nodes.find((node) => node.id === outcome.variantNodeId)!;
    // The original is byte-identical: a variant is a sibling, not an edit.
    expect(source.payload).toEqual({
      title: 'Launch note',
      content: 'HII ships when the trust loop closes.'
    });
    expect(source.updatedAt).toBe('2026-08-08T09:00:00.000Z');
    expect(variant.x).toBe(448);
    expect(variant.y).toBe(200);
    expect(variant.object).toMatchObject({ kind: 'artifact', owner: 'agent', parentId: 'source-1' });
    expect(variant.payload.content).toBe('A shorter, warmer launch note.');
  });

  it('records typed lineage back to the source', async () => {
    await seed();
    const prepared = await proposal();
    await writeArtifact(prepared.requiredArtifact);
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const outcome = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: '/tmp/receipt.json',
      workspaceRoot,
      completion: declared
    });
    if (!outcome.materialized) throw new Error('expected materialization');
    expect(outcome.relations).toEqual(['VARIANT_OF', 'DERIVED_FROM', 'GENERATED_BY', 'VERIFIED_BY']);
    expect(outcome.verified).toBe(true);

    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const relations = readOperationalSpace('default').relations;
    const variantOf = relations.find((entry) => entry.type === 'VARIANT_OF')!;
    expect(variantOf.fromObjectId).toContain(outcome.variantNodeId);
    expect(variantOf.toObjectId).toContain('source-1');
  });

  it('records no VERIFIED_BY when the proof is only incidental', async () => {
    await seed();
    const prepared = await proposal();
    await writeArtifact(prepared.requiredArtifact);
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const outcome = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: null,
      workspaceRoot,
      completion: incidental
    });
    if (!outcome.materialized) throw new Error('expected materialization');
    // An unverified branch is visibly unverified rather than quietly
    // indistinguishable from a verified one.
    expect(outcome.relations).toEqual(['VARIANT_OF', 'DERIVED_FROM', 'GENERATED_BY']);
    expect(outcome.verified).toBe(false);
  });

  it('creates no branch at all when the run did not meet its declared outcome', async () => {
    await seed();
    const prepared = await proposal();
    // The file even exists; the run's verdict is what decides, not the file.
    await writeArtifact(prepared.requiredArtifact);
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const outcome = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: null,
      workspaceRoot,
      completion: failed
    });
    expect(outcome).toMatchObject({ materialized: false });
    if (outcome.materialized) return;
    expect(outcome.reason).toContain('Required artifact missing');

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    expect((await loadWorkspace()).workspace.nodes).toHaveLength(1);
    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    expect(readOperationalSpace('default').relations.filter((r) => r.canonicalSource === 'graph')).toHaveLength(0);
  });

  it('creates no branch when the declared artifact is missing or empty', async () => {
    await seed();
    const prepared = await proposal();
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const absent = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: null,
      workspaceRoot,
      completion: declared
    });
    expect(absent).toMatchObject({ materialized: false, reason: expect.stringContaining('not on disk') });

    await writeArtifact(prepared.requiredArtifact, '');
    const empty = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: null,
      workspaceRoot,
      completion: declared
    });
    expect(empty).toMatchObject({ materialized: false, reason: expect.stringContaining('empty') });
  });

  it('lets a variant become the source of another variant', async () => {
    await seed();
    const first = await proposal();
    await writeArtifact(first.requiredArtifact);
    const { materializeVariantBranch, prepareVariantBranch } = await import(
      '../../lib/server/workspace-variant'
    );
    const one = await materializeVariantBranch({
      proposal: first,
      runId: 'run-1',
      receiptPath: null,
      workspaceRoot,
      completion: declared
    });
    if (!one.materialized) throw new Error('expected materialization');

    const second = await prepareVariantBranch({
      workspaceId: 'default',
      sourceNodeId: one.variantNodeId,
      instruction: 'Now make it formal.',
      medium: 'text'
    });
    await writeArtifact(second.requiredArtifact, 'A formal launch note.');
    const two = await materializeVariantBranch({
      proposal: second,
      runId: 'run-2',
      receiptPath: null,
      workspaceRoot,
      completion: declared
    });
    if (!two.materialized) throw new Error('expected second materialization');

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    const doc = (await loadWorkspace()).workspace;
    expect(doc.nodes).toHaveLength(3);
    expect(doc.nodes.find((node) => node.id === two.variantNodeId)!.object?.parentId).toBe(
      one.variantNodeId
    );
  });

  it('places a second sibling beside the first rather than on top of it', async () => {
    await seed();
    const first = await proposal();
    await writeArtifact(first.requiredArtifact);
    const { materializeVariantBranch, prepareVariantBranch } = await import(
      '../../lib/server/workspace-variant'
    );
    await materializeVariantBranch({
      proposal: first,
      runId: 'run-1',
      receiptPath: null,
      workspaceRoot,
      completion: declared
    });
    const second = await prepareVariantBranch({
      workspaceId: 'default',
      sourceNodeId: 'source-1',
      instruction: 'Another angle.',
      medium: 'text'
    });
    expect(second.placement.x).toBe(796);
  });

  it('survives a restart with its lineage and content intact', async () => {
    await seed();
    const prepared = await proposal();
    await writeArtifact(prepared.requiredArtifact);
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const outcome = await materializeVariantBranch({
      proposal: prepared,
      runId: 'run-1',
      receiptPath: '/tmp/receipt.json',
      workspaceRoot,
      completion: declared
    });
    if (!outcome.materialized) throw new Error('expected materialization');

    const { resetOperationalObjectStoreForTests } = await import(
      '../../lib/server/operational-object-store'
    );
    resetOperationalObjectStoreForTests();
    vi.resetModules();

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    const doc = (await loadWorkspace()).workspace;
    expect(doc.nodes.map((node) => node.id)).toContain(outcome.variantNodeId);
    expect(readOperationalSpace('default').relations.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['VARIANT_OF', 'DERIVED_FROM', 'GENERATED_BY', 'VERIFIED_BY'])
    );
  });
});
