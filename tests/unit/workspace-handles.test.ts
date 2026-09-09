// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { describe, expect, it } from 'vitest';
import {
  handleCompletions,
  resolveHandles,
  workspaceHandles
} from '@/lib/workspace/handles';
import { makeNode } from '@/lib/workspace/ingest';
import type { WorkspaceNode } from '@/lib/workspace/types';

/**
 * `@name` is how a person selects an object without clicking it, so a handle
 * that quietly points somewhere else is a wrong-object bug wearing a typo's
 * clothes. These pin the three ways that happens: a derived handle winning over
 * an authored one, two objects colliding on the same title, and an unknown name
 * resolving to something rather than failing.
 */

let clock = 0;
function node(title: string, handle?: string): WorkspaceNode {
  clock += 1;
  const created = makeNode({ type: 'note', payload: { title } } as Parameters<typeof makeNode>[0], 0, 0, clock);
  return {
    ...created,
    id: `node-${clock}`,
    handle,
    createdAt: `2026-09-08T00:00:${String(clock).padStart(2, '0')}.000Z`
  };
}

describe('workspace handles', () => {
  it('prefers an authored handle over one derived from a title', () => {
    const authored = node('Quarterly numbers', 'q3');
    const table = workspaceHandles([authored]);

    expect(table).toHaveLength(1);
    expect(table[0].handle).toBe('q3');
    expect(table[0].kind).toBe('assigned');
    // The point of an authored handle: a retitle must not move it.
    const retitled = { ...authored, payload: { ...authored.payload, title: 'Something else' } };
    expect(workspaceHandles([retitled])[0].handle).toBe('q3');
  });

  it('gives colliding titles stable, distinct handles', () => {
    const nodes = [node('Ocean house'), node('Ocean house'), node('Ocean house')];
    const handles = workspaceHandles(nodes).map((entry) => entry.handle);

    expect(handles).toEqual(['ocean-house', 'ocean-house-2', 'ocean-house-3']);
    expect(new Set(handles).size).toBe(3);
    // Deterministic: the same input must not renumber between renders.
    expect(workspaceHandles(nodes).map((entry) => entry.handle)).toEqual(handles);
  });

  it('reports an unknown handle instead of resolving it to a neighbour', () => {
    const nodes = [node('Ocean house')];
    const resolved = resolveHandles('compare @ocean-house with @ocean-shack', nodes);

    expect(resolved.nodes.map((entry) => entry.id)).toEqual([nodes[0].id]);
    expect(resolved.unresolved.map((reference) => reference.raw)).toEqual(['@ocean-shack']);
    // A resolved handle becomes the object's title for the model; an unresolved
    // one stays verbatim so the failure names what the person actually typed.
    expect(resolved.text).toContain('Ocean house');
    expect(resolved.text).toContain('@ocean-shack');
  });

  it('ranks completions by prefix, then by authored over derived', () => {
    const nodes = [node('Ocean house sketches'), node('House plan', 'house')];
    const matches = handleCompletions('house', nodes);

    expect(matches[0].handle).toBe('house');
    expect(matches.map((entry) => entry.handle)).toContain('ocean-house-sketches');
  });
});
