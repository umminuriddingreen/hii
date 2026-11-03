// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contextRefKey,
  normalizeContextRef,
  normalizeContextRefs,
  widestTransmissionScope
} from '../../lib/context/refs';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-context-refs-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

function workspace(): WorkspaceDoc {
  return {
    version: 1,
    revision: 0,
    updatedAt: '2026-08-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 2,
    nodes: [
      {
        id: 'note-1',
        type: 'note',
        x: 0,
        y: 0,
        w: 200,
        h: 120,
        z: 1,
        createdAt: '2026-08-08T09:00:00.000Z',
        updatedAt: '2026-08-08T09:30:00.000Z',
        payload: { title: 'Ambient intelligence', content: 'The Notch answers one question.' }
      }
    ],
    links: []
  };
}

async function seedWorkspace() {
  const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
  const initial = await loadWorkspace();
  return writeWorkspace(workspace(), initial.workspace.revision);
}

describe('durable context references', () => {
  it('normalizes pointers and refuses unknown kinds or empty ids', () => {
    expect(normalizeContextRef({ kind: 'workspace-object', id: 'note-1' })).toEqual({
      kind: 'workspace-object',
      id: 'note-1'
    });
    expect(normalizeContextRef({ kind: 'mystery', id: 'x' })).toBeNull();
    expect(normalizeContextRef({ kind: 'workspace-object', id: '   ' })).toBeNull();
    // A ref carries addressing, never content.
    expect(
      normalizeContextRef({ kind: 'workspace-object', id: 'n', excerpt: 'copied text' })
    ).not.toHaveProperty('excerpt');
  });

  it('deduplicates refs by identity including their anchor', () => {
    const refs = normalizeContextRefs([
      { kind: 'knowledge-note', id: 'n1' },
      { kind: 'knowledge-note', id: 'n1' },
      { kind: 'knowledge-note', id: 'n1', anchor: { lineStart: 4, lineEnd: 9 } }
    ]);
    expect(refs).toHaveLength(2);
    expect(contextRefKey(refs[1])).toContain('#4-9');
  });

  it('reports the widest transmission scope in a set', () => {
    expect(widestTransmissionScope(['local-only', 'local-model'])).toBe('local-model');
    expect(widestTransmissionScope(['local-only', 'external-model', 'local-model'])).toBe('external-model');
    expect(widestTransmissionScope(['external-model', 'blocked'])).toBe('blocked');
  });

  it('resolves a workspace object against the persisted document, not the caller', async () => {
    await seedWorkspace();
    const { resolveContextRefs } = await import('../../lib/server/context-refs');
    const resolution = await resolveContextRefs([
      { kind: 'workspace-object', id: 'note-1', scope: 'default' }
    ]);
    expect(resolution.items).toHaveLength(1);
    expect(resolution.items[0]).toMatchObject({
      status: 'resolved',
      title: 'Ambient intelligence',
      excerpt: 'The Notch answers one question.',
      transmissionScope: 'local-only'
    });
    expect(resolution.unresolved).toHaveLength(0);
  });

  it('reports missing references instead of dropping them', async () => {
    await seedWorkspace();
    const { resolveContextRefs } = await import('../../lib/server/context-refs');
    const resolution = await resolveContextRefs([
      { kind: 'workspace-object', id: 'note-1', scope: 'default' },
      { kind: 'workspace-object', id: 'ghost', scope: 'default' }
    ]);
    expect(resolution.items).toHaveLength(2);
    expect(resolution.unresolved).toHaveLength(1);
    expect(resolution.unresolved[0]).toMatchObject({ status: 'missing' });
    expect(resolution.notice).toContain('1 need attention');
  });

  it('marks a reference stale when the source changed since it was selected', async () => {
    await seedWorkspace();
    const { resolveContextRefs } = await import('../../lib/server/context-refs');
    const fresh = await resolveContextRefs([{ kind: 'workspace-object', id: 'note-1', scope: 'default' }]);
    const seenSha256 = fresh.items[0].sha256!;

    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const current = await loadWorkspace();
    const changed = workspace();
    changed.nodes[0].payload.content = 'Something else entirely.';
    await writeWorkspace(changed, current.workspace.revision);

    const after = await resolveContextRefs([
      { kind: 'workspace-object', id: 'note-1', scope: 'default', seenSha256 }
    ]);
    expect(after.items[0].status).toBe('stale');
    expect(after.unresolved).toHaveLength(1);
  });

  it('resolves a receipt artifact from disk and reports one that is gone', async () => {
    const artifact = path.join(runtimeDir, 'report.md');
    await writeFile(artifact, '# report\n');
    const { resolveContextRefs } = await import('../../lib/server/context-refs');
    const resolution = await resolveContextRefs([
      { kind: 'receipt-artifact', id: artifact },
      { kind: 'receipt-artifact', id: path.join(runtimeDir, 'absent.md') }
    ]);
    expect(resolution.items[0]).toMatchObject({ status: 'resolved', title: 'report.md', type: 'md' });
    expect(resolution.items[1].status).toBe('missing');
  });

  it('blocks a secret-like source rather than downgrading it', async () => {
    const secret = path.join(runtimeDir, '.env');
    await writeFile(secret, 'TOKEN=abc\n');
    const { resolveContextRefs } = await import('../../lib/server/context-refs');
    const resolution = await resolveContextRefs([{ kind: 'receipt-artifact', id: secret }]);
    expect(resolution.items[0].status).toBe('blocked');
    expect(resolution.transmissionScope).toBe('blocked');
  });

  it('freezes a reviewed manifest whose fingerprint changes with its content', async () => {
    await seedWorkspace();
    const { resolveContextRefs, reviewContextResolution, approvalMatchesManifest } = await import(
      '../../lib/server/context-refs'
    );
    const resolution = await resolveContextRefs([
      { kind: 'workspace-object', id: 'note-1', scope: 'default' }
    ]);
    const manifest = reviewContextResolution(resolution, { workspaceId: 'default', workspaceRevision: 1 });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].excerpt).toBe('The Notch answers one question.');
    expect(manifest.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalMatchesManifest(manifest, manifest.fingerprint)).toBe(true);
    expect(approvalMatchesManifest(manifest, 'something-else')).toBe(false);

    // Re-freezing identical content is identical: the fingerprint is content, not time.
    const again = reviewContextResolution(
      await resolveContextRefs([{ kind: 'workspace-object', id: 'note-1', scope: 'default' }]),
      { workspaceId: 'default', workspaceRevision: 1 }
    );
    expect(again.fingerprint).toBe(manifest.fingerprint);

    // A changed selection cannot inherit the old approval.
    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const current = await loadWorkspace();
    const changed = workspace();
    changed.nodes[0].payload.content = 'Different.';
    await writeWorkspace(changed, current.workspace.revision);
    const drifted = reviewContextResolution(
      await resolveContextRefs([{ kind: 'workspace-object', id: 'note-1', scope: 'default' }]),
      { workspaceId: 'default', workspaceRevision: 2 }
    );
    expect(drifted.fingerprint).not.toBe(manifest.fingerprint);
    expect(approvalMatchesManifest(drifted, manifest.fingerprint)).toBe(false);
  });

  it('records unresolved references in the manifest rather than silently shrinking it', async () => {
    await seedWorkspace();
    const { resolveContextRefs, reviewContextResolution } = await import('../../lib/server/context-refs');
    const manifest = reviewContextResolution(
      await resolveContextRefs([
        { kind: 'workspace-object', id: 'note-1', scope: 'default' },
        { kind: 'workspace-object', id: 'ghost', scope: 'default' }
      ])
    );
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.unresolved).toHaveLength(1);
    expect(manifest.unresolved[0].status).toBe('missing');
  });

  it('converts legacy copied context items into refs that re-resolve', async () => {
    await seedWorkspace();
    const { contextRefsFromLegacyItems, resolveContextRefs } = await import(
      '../../lib/server/context-refs'
    );
    const refs = contextRefsFromLegacyItems(
      [{ id: 'note-1', title: 'stale copy', type: 'note', excerpt: 'old text' }],
      'default'
    );
    expect(refs).toEqual([{ kind: 'workspace-object', id: 'note-1', scope: 'default' }]);
    const resolution = await resolveContextRefs(refs);
    // The live source wins over the copy the old intent carried.
    expect(resolution.items[0].excerpt).toBe('The Notch answers one question.');
  });
});

describe('cross-window selection handoff', () => {
  it('carries coordinates only', async () => {
    const { publishWorkspaceSelection } = await import('../../lib/server/workspace-selection-channel');
    const signal = publishWorkspaceSelection({
      workspaceId: 'default',
      workspaceRevision: 7,
      selectedNodeIds: ['note-1', 'note-1', 'note-2'],
      activeSceneId: 'scene-1',
      sourceWindow: 'workspace',
      // Content must not survive the channel, whatever a window sends.
      excerpt: 'secret text',
      title: 'copied title'
    });
    expect(signal).toEqual({
      workspaceId: 'default',
      workspaceRevision: 7,
      selectedNodeIds: ['note-1', 'note-2'],
      activeSceneId: 'scene-1',
      sourceWindow: 'workspace',
      capturedAt: expect.any(String)
    });
  });

  it('expires a stale selection instead of presenting it as current', async () => {
    const { publishWorkspaceSelection, readWorkspaceSelection, SELECTION_TTL_MS } = await import(
      '../../lib/server/workspace-selection-channel'
    );
    const at = Date.now();
    publishWorkspaceSelection(
      { workspaceId: 'default', workspaceRevision: 1, selectedNodeIds: ['note-1'], sourceWindow: 'workspace' },
      at
    );
    expect(readWorkspaceSelection('default', at + 1_000)?.selectedNodeIds).toEqual(['note-1']);
    expect(readWorkspaceSelection('default', at + SELECTION_TTL_MS + 1)).toBeNull();
  });

  it('lets voice reach the live selection without persisting it in the workspace', async () => {
    await seedWorkspace();
    const { publishWorkspaceSelection } = await import('../../lib/server/workspace-selection-channel');
    publishWorkspaceSelection({
      workspaceId: 'default',
      workspaceRevision: 1,
      selectedNodeIds: ['note-1'],
      sourceWindow: 'workspace'
    });
    const { resolveVoiceWorkspaceContext } = await import('../../lib/server/hii-voice-workspace-context');
    const context = await resolveVoiceWorkspaceContext({});
    expect(context.selectionSource).toBe('window-handoff');
    expect(context.selectedNodeIds).toEqual(['note-1']);
    expect(context.refs).toEqual([{ kind: 'workspace-object', id: 'note-1', scope: 'default' }]);

    // The document itself is untouched: selection is not a property of it.
    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    const doc = await loadWorkspace();
    expect(JSON.stringify(doc.workspace)).not.toContain('selectedNodeIds');
  });

  it('keeps the honest no-selection state when nothing was published', async () => {
    await seedWorkspace();
    const { resolveVoiceWorkspaceContext } = await import('../../lib/server/hii-voice-workspace-context');
    const context = await resolveVoiceWorkspaceContext({});
    expect(context.selectionSource).toBe('none');
    expect(context.items).toEqual([]);
    expect(context.refs).toEqual([]);
    expect(context.notice).toContain('No workspace objects were selected');
  });

  it('prefers what the caller named over the published selection', async () => {
    await seedWorkspace();
    const { publishWorkspaceSelection } = await import('../../lib/server/workspace-selection-channel');
    publishWorkspaceSelection({
      workspaceId: 'default',
      workspaceRevision: 1,
      selectedNodeIds: ['note-1'],
      sourceWindow: 'workspace'
    });
    const { resolveVoiceWorkspaceContext } = await import('../../lib/server/hii-voice-workspace-context');
    const context = await resolveVoiceWorkspaceContext({ workspaceId: 'default', nodeIds: ['ghost'] });
    expect(context.selectionSource).toBe('caller');
    expect(context.unresolvedNodeIds).toEqual(['ghost']);
  });
});
