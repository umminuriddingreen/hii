// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';
let packsFile = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-packs-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  packsFile = path.join(runtimeDir, 'context', 'packs.jsonl');
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function workspace(content = 'HII ships when the trust loop closes.'): WorkspaceDoc {
  return {
    version: 1,
    revision: 0,
    updatedAt: '2026-08-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 3,
    nodes: [
      { id: 'note-1', type: 'note', x: 0, y: 0, w: 200, h: 120, z: 1, createdAt: '2026-08-08T09:00:00.000Z', updatedAt: '2026-08-08T09:00:00.000Z', payload: { title: 'Launch', content } },
      { id: 'note-2', type: 'note', x: 300, y: 0, w: 200, h: 120, z: 2, createdAt: '2026-08-08T09:00:00.000Z', updatedAt: '2026-08-08T09:00:00.000Z', payload: { title: 'Pricing', content: 'Founder pricing holds until August.' } }
    ],
    links: []
  };
}

async function seed(doc = workspace()) {
  const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
  const initial = await loadWorkspace();
  return writeWorkspace(doc, initial.workspace.revision);
}

async function packs() {
  return import('../../lib/server/context-packs');
}

const refs = [
  { kind: 'workspace-object', id: 'note-1', scope: 'default' },
  { kind: 'workspace-object', id: 'note-2', scope: 'default' }
];

async function makePack() {
  const { createContextPack } = await packs();
  return createContextPack(
    { title: 'Launch context', purpose: 'Everything needed to write launch copy.', owner: 'ummi', refs },
    packsFile
  );
}

describe('context packs', () => {
  it('stores pointers and versions, not a second copy of the content', async () => {
    await seed();
    const { pack } = await makePack();
    expect(pack.refs).toEqual([
      { kind: 'workspace-object', id: 'note-1', scope: 'default' },
      { kind: 'workspace-object', id: 'note-2', scope: 'default' }
    ]);
    expect(pack.sourceVersions).toHaveLength(2);
    expect(pack.sourceVersions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // Duplicating Dock or workspace content would be a second thing to keep in
    // sync and a second place for it to go stale silently.
    expect(JSON.stringify(pack)).not.toContain('trust loop closes');
    expect(pack.reviewState).toBe('draft');
  });

  it('refuses a pack with no title, owner, or references', async () => {
    await seed();
    const { createContextPack } = await packs();
    await expect(createContextPack({ owner: 'ummi', refs }, packsFile)).rejects.toThrow(/needs a title/);
    await expect(createContextPack({ title: 'x', refs }, packsFile)).rejects.toThrow(/needs an owner/);
    await expect(createContextPack({ title: 'x', owner: 'ummi', refs: [] }, packsFile)).rejects.toThrow(
      /at least one reference/
    );
  });

  it('keeps reference order, because order is what the human wants read', async () => {
    await seed();
    const { reviseContextPack } = await packs();
    const { pack } = await makePack();
    const revised = await reviseContextPack(pack.id, { refs: [refs[1], refs[0]] }, packsFile);
    expect(revised.pack.refs.map((ref) => ref.id)).toEqual(['note-2', 'note-1']);
  });

  it('resolves against live sources and detects drift', async () => {
    await seed();
    const { pack } = await makePack();
    const { inspectContextPack, reviewContextPack } = await packs();

    const fresh = await inspectContextPack(pack.id, packsFile);
    expect(fresh.stale).toHaveLength(0);
    expect(fresh.notice).toBe('Every reference is current.');
    expect(fresh.manifest.entries[0].excerpt).toContain('trust loop closes');

    await reviewContextPack(pack.id, 'ummi', packsFile);
    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const current = await loadWorkspace();
    await writeWorkspace(workspace('Something completely different.'), current.workspace.revision);

    const drifted = await inspectContextPack(pack.id, packsFile);
    // A copied pack could never tell you it had gone out of date.
    expect(drifted.stale).toHaveLength(1);
    expect(drifted.reviewState).toBe('stale');
    expect(drifted.notice).toContain('1 reference changed');
  });

  it('reports a reference that disappeared', async () => {
    await seed();
    const { pack } = await makePack();
    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const current = await loadWorkspace();
    const trimmed = workspace();
    trimmed.nodes = trimmed.nodes.slice(0, 1);
    await writeWorkspace(trimmed, current.workspace.revision);
    const { inspectContextPack } = await packs();
    const inspection = await inspectContextPack(pack.id, packsFile);
    expect(inspection.stale.map((entry) => entry.now)).toEqual([null]);
  });

  it('requires the approval to quote the fingerprint it saw', async () => {
    await seed();
    const { pack } = await makePack();
    const { approveContextPack, inspectContextPack, reviewContextPack } = await packs();
    await reviewContextPack(pack.id, 'ummi', packsFile);
    const inspection = await inspectContextPack(pack.id, packsFile);

    await expect(
      approveContextPack(pack.id, { approvedBy: 'ummi', fingerprint: 'wrong' }, packsFile)
    ).rejects.toThrow(/changed since it was reviewed/);
    await expect(
      approveContextPack(pack.id, { fingerprint: inspection.manifest.fingerprint }, packsFile)
    ).rejects.toThrow(/human who gave it/);

    const approved = await approveContextPack(
      pack.id,
      { approvedBy: 'ummi', fingerprint: inspection.manifest.fingerprint },
      packsFile
    );
    expect(approved.pack.reviewState).toBe('approved');
    expect(approved.pack.approvedFingerprint).toBe(inspection.manifest.fingerprint);
  });

  it('refuses to approve a pack whose sources moved after review', async () => {
    await seed();
    const { pack } = await makePack();
    const { approveContextPack, inspectContextPack, reviewContextPack } = await packs();
    await reviewContextPack(pack.id, 'ummi', packsFile);
    const reviewed = await inspectContextPack(pack.id, packsFile);

    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const current = await loadWorkspace();
    await writeWorkspace(workspace('Changed after review.'), current.workspace.revision);

    await expect(
      approveContextPack(pack.id, { approvedBy: 'ummi', fingerprint: reviewed.manifest.fingerprint }, packsFile)
    ).rejects.toThrow(/Review it again/);
  });

  it('drops an approval when the pack is revised or reviewed again', async () => {
    await seed();
    const { pack } = await makePack();
    const { approveContextPack, inspectContextPack, reviewContextPack, reviseContextPack } = await packs();
    await reviewContextPack(pack.id, 'ummi', packsFile);
    const inspection = await inspectContextPack(pack.id, packsFile);
    await approveContextPack(pack.id, { approvedBy: 'ummi', fingerprint: inspection.manifest.fingerprint }, packsFile);

    const revised = await reviseContextPack(pack.id, { refs: [refs[0]] }, packsFile);
    // What was approved is no longer what this pack is.
    expect(revised.pack.reviewState).toBe('draft');
    expect(revised.pack.approvedFingerprint).toBeNull();
  });

  it('compares two revisions', async () => {
    await seed();
    const { pack } = await makePack();
    const { compareContextPackRevisions, reviseContextPack } = await packs();
    await reviseContextPack(pack.id, { refs: [refs[1]] }, packsFile);
    const diff = await compareContextPackRevisions(pack.id, 1, 2, packsFile);
    expect(diff.removed).toEqual(['workspace-object:default:note-1']);
    expect(diff.added).toEqual([]);
  });

  it('keeps every revision in the ledger', async () => {
    await seed();
    const { pack } = await makePack();
    const { readContextPacks, reviewContextPack, reviseContextPack } = await packs();
    await reviewContextPack(pack.id, 'ummi', packsFile);
    await reviseContextPack(pack.id, { title: 'Renamed' }, packsFile);
    const ledger = await readContextPacks(packsFile);
    // A run that used revision 1 can still be understood after revision 3 exists.
    expect(ledger.events.map((event) => event.kind)).toEqual(['pack.created', 'pack.reviewed', 'pack.revised']);
    expect(ledger.packs).toHaveLength(1);
    expect(ledger.packs[0].revision).toBe(3);
  });
});
