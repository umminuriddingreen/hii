// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { describe, expect, it } from 'vitest';
import {
  applyProposal,
  createProposal,
  formatPreview,
  previewProposal,
  staleVersionError
} from '@/lib/workspace/proposed-operations';
import { normalizeWorkspace, type WorkspaceDoc, type WorkspaceNode } from '@/lib/workspace/types';

/**
 * PREVIEW is the stage where the user's judgment goes, so its one job is to
 * describe a change against the state the user is actually looking at.
 *
 * The failure it exists to prevent is silent: a diff computed a minute ago,
 * approved now, applied over work someone did in between. Staleness is checked
 * against `expectedSequence` — the same value `runtime_space_apply_v1` checks —
 * so the canvas and the Runtime refuse a stale write on identical grounds.
 */

function doc(revision = 4): WorkspaceDoc {
  return normalizeWorkspace({
    version: 1,
    revision,
    updatedAt: '2026-09-08T10:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 3,
    nodes: [
      { id: 'note-1', type: 'note', x: 0, y: 0, w: 280, h: 200, z: 1, createdAt: '2026-09-08T09:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z', payload: { title: 'Ocean house', text: 'first draft' } },
      { id: 'note-2', type: 'note', x: 320, y: 0, w: 280, h: 200, z: 2, createdAt: '2026-09-08T09:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z', payload: { title: 'Site notes' } }
    ],
    links: []
  });
}

const rename = { op: 'update' as const, nodeId: 'note-1', patch: { payload: { title: 'Ocean house', text: 'second draft' } } as Partial<WorkspaceNode>, reason: 'tighten the copy' };

describe('proposed operations', () => {
  it('computes the diff against the sequence it was built on', () => {
    const base = doc();
    const proposal = createProposal({ intent: 'Rewrite the draft', operations: [rename], doc: base });

    expect(proposal.expectedSequence).toBe(4);
    const preview = previewProposal(proposal, base);
    expect(preview.updates).toBe(1);
    expect(preview.stale).toBe(false);
    expect(preview.operations[0].changes.map((change) => change.field)).toEqual(['payload']);
  });

  it('refuses to apply over state that moved, in the Runtime’s own vocabulary', () => {
    const proposal = createProposal({ intent: 'Rewrite the draft', operations: [rename], doc: doc() });
    const moved = doc(5);

    const result = applyProposal(proposal, moved);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('stale-version');
    expect(staleVersionError(proposal, result.preview).code).toBe('stale-version');
    // The document is untouched: a refused apply changes nothing.
    expect(moved.nodes[0].payload.text).toBe('first draft');
  });

  it('prefers an explicit Runtime sequence over the document revision', () => {
    const base = doc();
    const proposal = createProposal({ intent: 'Rewrite', operations: [rename], doc: base, expectedSequence: 91 });

    expect(previewProposal(proposal, base).stale).toBe(true);
    expect(previewProposal(proposal, base, 91).stale).toBe(false);
    expect(applyProposal(proposal, base, { currentSequence: 91 }).ok).toBe(true);
  });

  it('skips a conflicting operation instead of forcing it', () => {
    const base = doc();
    const proposal = createProposal({
      intent: 'Tidy up',
      operations: [rename, { op: 'delete', nodeId: 'note-gone' }],
      doc: base
    });
    const result = applyProposal(proposal, base);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.applied).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.doc.nodes.find((node) => node.id === 'note-1')?.payload.text).toBe('second draft');
  });

  it('renders one preview text that a terminal and a canvas can both show', () => {
    const base = doc();
    const proposal = createProposal({ intent: 'Rewrite the draft', operations: [rename], doc: base });
    const text = formatPreview(previewProposal(proposal, base));

    expect(text).toContain('Rewrite the draft');
    expect(text).toContain('~ Ocean house');
    expect(text).toContain('payload');
  });
});
