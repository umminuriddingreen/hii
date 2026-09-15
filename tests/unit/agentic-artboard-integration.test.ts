// @vitest-environment node
/**
 * The agentic artboard spine, end to end.
 *
 * INTENT → REVIEWED CONTEXT → APPROVAL → BOUNDED EXECUTION → DECLARED OUTCOME
 * → VERIFIED RESULT → RECEIPT → OBJECT → LINEAGE → RESTART.
 *
 * Every slice has its own tests; this one exists because the failures worth
 * catching are the ones between them — an approval that survives a context
 * change, a grant that widens when a rectangle moves, a variant that appears
 * after a run that did not produce anything, lineage that does not survive a
 * restart. Those only show up when the pieces run in sequence.
 *
 * The model call is the one thing not exercised here: it needs a live runtime,
 * and it is proven separately against an isolated one.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDoc } from '../../lib/workspace/types';

let runtimeDir = '';
let workspaceRoot = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-artboard-'));
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-artboard-root-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  const store = await import('../../lib/server/operational-object-store');
  store.resetOperationalObjectStoreForTests();
  const channel = await import('../../lib/server/workspace-selection-channel');
  channel.resetWorkspaceSelectionChannelForTests();
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

const declaredProof = { completed: true, legacy: false, proofStrength: 'declared', reasons: [] };

function workspace(): WorkspaceDoc {
  return {
    version: 1,
    revision: 0,
    updatedAt: '2026-08-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 3,
    nodes: [
      { id: 'launch-note', type: 'note', x: 100, y: 100, w: 300, h: 200, z: 1, createdAt: '2026-08-08T09:00:00.000Z', updatedAt: '2026-08-08T09:00:00.000Z', payload: { title: 'Launch', content: 'HII ships when the trust loop closes.' } },
      { id: 'pricing-note', type: 'note', x: 500, y: 100, w: 300, h: 200, z: 2, createdAt: '2026-08-08T09:00:00.000Z', updatedAt: '2026-08-08T09:00:00.000Z', payload: { title: 'Pricing', content: 'Founder pricing holds until August.' } }
    ],
    links: []
  };
}

async function openWorkspace(doc = workspace()) {
  const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
  const initial = await loadWorkspace();
  return writeWorkspace(doc, initial.workspace.revision);
}

describe('agentic artboard vertical slice', () => {
  it('carries one intent from selection through to a verified, restart-safe branch', async () => {
    // 1–2. Open a workspace and select objects.
    await openWorkspace();

    // 3. The selection reaches the Notch through the ephemeral handoff.
    const { publishWorkspaceSelection } = await import('../../lib/server/workspace-selection-channel');
    publishWorkspaceSelection({
      workspaceId: 'default',
      workspaceRevision: 1,
      selectedNodeIds: ['launch-note', 'pricing-note'],
      sourceWindow: 'workspace'
    });
    const { notchPresentation, emptyNotchInputs } = await import('../../lib/notch/ambient-state');
    const { readWorkspaceSelection } = await import('../../lib/server/workspace-selection-channel');
    const selection = readWorkspaceSelection('default');
    expect(selection?.selectedNodeIds).toEqual(['launch-note', 'pricing-note']);
    expect(
      notchPresentation({ ...emptyNotchInputs(), selection }).message
    ).toBe('2 objects selected');

    // 4–5. A spoken variation intent resolves refs against authoritative state.
    const { resolveVoiceWorkspaceContext } = await import('../../lib/server/hii-voice-workspace-context');
    const voiceContext = await resolveVoiceWorkspaceContext({});
    expect(voiceContext.selectionSource).toBe('window-handoff');
    expect(voiceContext.refs.map((ref) => ref.id)).toEqual(['launch-note', 'pricing-note']);

    // 6. The immutable manifest.
    const { prepareVariantBranch } = await import('../../lib/server/workspace-variant');
    const proposal = await prepareVariantBranch({
      workspaceId: 'default',
      sourceNodeId: 'launch-note',
      instruction: 'Make it shorter and warmer.',
      medium: 'text'
    });
    expect(proposal.manifest.entries[0].excerpt).toContain('trust loop closes');
    expect(proposal.declaredOutcome.artifacts).toEqual([proposal.requiredArtifact]);

    // 7. Object and transmission grants are inspectable before approval.
    const { approveObjectGrant, describeObjectGrant, grantToScope } = await import(
      '../../lib/server/object-grants'
    );
    const grant = await approveObjectGrant({
      subject: 'agent:hii-cli',
      spaceId: 'default',
      approvedBy: 'ummi',
      readableObjectIds: ['workspace:default:object:launch-note'],
      creatableTypes: ['artifact'],
      allowedRelationTypes: ['VARIANT_OF', 'DERIVED_FROM'],
      allowedOperations: ['read', 'create', 'relate'],
      projectionScope: [],
      externalTransmission: 'blocked',
      runId: 'run-artboard-1',
      intentId: 'intent-1',
      territory: { x: 80, y: 80, w: 900, h: 400 }
    });
    const described = describeObjectGrant(grant);
    expect(described.mayNot).toContain('send anything externally');
    expect(described.mayNot).toContain('edit source objects');
    expect(proposal.manifest.transmissionScope).toBe('local-only');

    // 8. The approval must quote what it saw.
    const { approvalMatchesManifest } = await import('../../lib/server/context-refs');
    expect(approvalMatchesManifest(proposal.manifest, 'a-different-fingerprint')).toBe(false);
    expect(approvalMatchesManifest(proposal.manifest, proposal.manifest.fingerprint)).toBe(true);

    // 9. Routing picks an eligible local model with a visible provider.
    const { routeModel } = await import('../../lib/server/model-catalog');
    const decision = routeModel(
      {
        generatedAt: new Date().toISOString(),
        models: [
          { provider: 'ollama', id: 'qwen3:8b', key: 'ollama:qwen3:8b', label: 'qwen3:8b', runtimeState: 'ready', privacy: 'local', inputModalities: ['text'], outputModalities: ['text'], acceptsImages: null, streaming: true, contextTokens: null, sizeBytes: null, latencyMs: null, lastMeasuredTTFTMs: null, lastMeasuredAt: null, switchPenaltyMs: null, latencyClass: 'unknown', quality: null, costPerMTokens: null, load: null },
          { provider: 'claude', id: 'claude-code', key: 'claude:claude-code', label: 'Claude Code', runtimeState: 'ready', privacy: 'external', inputModalities: ['text'], outputModalities: ['text'], acceptsImages: null, streaming: null, contextTokens: null, sizeBytes: null, latencyMs: null, lastMeasuredTTFTMs: null, lastMeasuredAt: null, switchPenaltyMs: null, latencyClass: 'unknown', quality: null, costPerMTokens: null, load: null }
        ],
        providers: [],
        unsupported: []
      },
      { privacy: 'local' }
    );
    expect(decision.chosen?.provider).toBe('ollama');
    expect(decision.excluded[0].reason).toContain('local-only');

    // 10–11. Bounded execution produces the declared artifact.
    const artifact = path.join(workspaceRoot, proposal.requiredArtifact);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, 'HII ships when you can prove it did.');

    // 12–14. The variant appears beside its source with typed lineage.
    const { materializeVariantBranch } = await import('../../lib/server/workspace-variant');
    const outcome = await materializeVariantBranch({
      proposal,
      runId: 'run-artboard-1',
      receiptPath: path.join(runtimeDir, 'receipt.json'),
      workspaceRoot,
      completion: declaredProof
    });
    if (!outcome.materialized) throw new Error(`expected a branch: ${outcome.reason}`);
    expect(outcome.relations).toEqual(['VARIANT_OF', 'DERIVED_FROM', 'GENERATED_BY', 'VERIFIED_BY']);

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    const afterRun = (await loadWorkspace()).workspace;
    // 13. The source survives untouched.
    expect(afterRun.nodes.find((node) => node.id === 'launch-note')!.payload.content).toBe(
      'HII ships when the trust loop closes.'
    );
    expect(afterRun.nodes.find((node) => node.id === outcome.variantNodeId)!.x).toBe(448);

    // 15. The Notch reports the result and does not fade an unmet one.
    expect(
      notchPresentation({
        ...emptyNotchInputs(),
        lastCompletedRun: { id: 'run-artboard-1', summary: 'Launch — variant', satisfied: true }
      }).target
    ).toEqual({ kind: 'run', id: 'run-artboard-1' });

    // 16–17. Restart. Everything survives and the variant can be refined again.
    const { resetOperationalObjectStoreForTests } = await import(
      '../../lib/server/operational-object-store'
    );
    resetOperationalObjectStoreForTests();
    vi.resetModules();

    const restarted = await import('../../lib/server/workspace-store');
    const restoredDoc = (await restarted.loadWorkspace()).workspace;
    expect(restoredDoc.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['launch-note', outcome.variantNodeId])
    );

    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    expect(readOperationalSpace('default').relations.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['VARIANT_OF', 'DERIVED_FROM', 'GENERATED_BY', 'VERIFIED_BY'])
    );

    const { resolveContextRefs } = await import('../../lib/server/context-refs');
    const stillResolvable = await resolveContextRefs(voiceContext.refs);
    expect(stillResolvable.unresolved).toHaveLength(0);

    const { readObjectGrants } = await import('../../lib/server/object-grants');
    const grantsAfter = await readObjectGrants();
    expect(grantsAfter.grants.map((entry) => entry.id)).toContain(grant.id);

    const { prepareVariantBranch: prepareAgain } = await import('../../lib/server/workspace-variant');
    const second = await prepareAgain({
      workspaceId: 'default',
      sourceNodeId: outcome.variantNodeId,
      instruction: 'Now make it formal.',
      medium: 'text'
    });
    expect(second.sourceNodeId).toBe(outcome.variantNodeId);
  });

  it('creates no branch when the run did not meet its declared outcome', async () => {
    await openWorkspace();
    const { prepareVariantBranch, materializeVariantBranch } = await import(
      '../../lib/server/workspace-variant'
    );
    const proposal = await prepareVariantBranch({
      workspaceId: 'default',
      sourceNodeId: 'launch-note',
      instruction: 'Make it shorter.',
      medium: 'text'
    });
    const outcome = await materializeVariantBranch({
      proposal,
      runId: 'run-failed',
      receiptPath: null,
      workspaceRoot,
      completion: {
        completed: false,
        legacy: false,
        proofStrength: 'declared',
        reasons: ['Required artifact missing: variant.md']
      }
    });
    expect(outcome.materialized).toBe(false);

    const { loadWorkspace } = await import('../../lib/server/workspace-store');
    expect((await loadWorkspace()).workspace.nodes).toHaveLength(2);
    const { readOperationalSpace } = await import('../../lib/server/operational-object-store');
    // No successful-looking artifact node, and no lineage asserting it came from
    // somewhere.
    expect(readOperationalSpace('default').relations.filter((r) => r.canonicalSource === 'graph')).toHaveLength(0);
  });

  it('refuses an approval carried onto context that changed after review', async () => {
    await openWorkspace();
    const { prepareVariantBranch } = await import('../../lib/server/workspace-variant');
    const { approvalMatchesManifest } = await import('../../lib/server/context-refs');
    const reviewed = await prepareVariantBranch({
      workspaceId: 'default',
      sourceNodeId: 'launch-note',
      instruction: 'Make it shorter.',
      medium: 'text'
    });

    const { loadWorkspace, writeWorkspace } = await import('../../lib/server/workspace-store');
    const current = await loadWorkspace();
    const edited = workspace();
    edited.nodes[0].payload.content = 'Completely different now.';
    await writeWorkspace(edited, current.workspace.revision);

    const refreshed = await prepareVariantBranch({
      workspaceId: 'default',
      sourceNodeId: 'launch-note',
      instruction: 'Make it shorter.',
      medium: 'text'
    });
    // The human said yes to one thing; the run would execute against another.
    expect(approvalMatchesManifest(refreshed.manifest, reviewed.manifest.fingerprint)).toBe(false);
  });

  it('does not let a moved territory widen what an agent may do', async () => {
    await openWorkspace();
    const { applyGraphMutation } = await import('../../lib/server/operational-graph-mutations');
    applyGraphMutation({
      spaceId: 'default',
      type: 'CREATE_OBJECT',
      actor: { actorId: 'human:ummi' },
      payload: { id: 'private-note', type: 'note' }
    });
    const { approveObjectGrant, grantToScope, moveObjectGrantTerritory } = await import(
      '../../lib/server/object-grants'
    );
    const grant = await approveObjectGrant({
      subject: 'agent:hii-cli',
      spaceId: 'default',
      approvedBy: 'ummi',
      readableObjectIds: ['workspace:default:object:launch-note'],
      allowedOperations: ['read'],
      externalTransmission: 'blocked',
      runId: 'run-1',
      territory: { x: 0, y: 0, w: 100, h: 100 }
    });
    const stretched = await moveObjectGrantTerritory(grant.id, { x: -9999, y: -9999, w: 99999, h: 99999 });
    const { readApprovedObject } = await import('../../lib/server/governed-objects');
    // The rectangle now covers the whole canvas. The grant does not.
    expect(() => readApprovedObject(grantToScope(stretched), 'private-note')).toThrow(
      /outside the approved read scope/
    );
  });
});
