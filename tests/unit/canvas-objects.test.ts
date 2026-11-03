import { describe, expect, it } from 'vitest';
import { canvasObjectContextText, canvasObjectPayload, canvasObjectState } from '../../lib/workspace/canvas-objects';
import { workspaceNodeContextExcerpt } from '../../lib/workspace/context-item';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(type: WorkspaceNode['type'], payload: Record<string, unknown>): WorkspaceNode {
  return { id: 'n', type, x: 0, y: 0, w: 100, h: 100, z: 1, createdAt: '', updatedAt: '', payload };
}

describe('canvas object payload adapters', () => {
  it('reads shape metadata from a legacy canvas-text node', () => {
    expect(canvasObjectPayload(node('canvas-text', {
      canvasKind: 'shape',
      shape: 'diamond',
      content: 'Decision',
      groupId: 'group-1',
      locked: true,
      appearance: { fill: '#fff4a8', opacity: 2, strokeWidth: -1 }
    }))).toEqual({
      canvasKind: 'shape',
      shape: 'diamond',
      content: 'Decision',
      groupId: 'group-1',
      locked: true,
      appearance: { fill: '#fff4a8', opacity: 1, strokeWidth: 0 }
    });
  });

  it('keeps tables on note nodes and exposes a TSV fallback for context', () => {
    const table = node('note', {
      canvasKind: 'table',
      table: { headerRow: true, rows: [['Name', 'Status'], ['Site', 'Ready']] },
      content: 'Name\tStatus\nSite\tReady'
    });
    expect(canvasObjectPayload(table)).toMatchObject({ canvasKind: 'table', table: { headerRow: true } });
    expect(canvasObjectContextText(table)).toBe('Name\tStatus\nSite\tReady');
    expect(workspaceNodeContextExcerpt(table)).toBe('Name Status Site Ready');
  });

  it('reads grouping and locking from any existing durable node type', () => {
    expect(canvasObjectState(node('image', { groupId: 'sources', locked: true }))).toEqual({
      appearance: undefined,
      groupId: 'sources',
      locked: true
    });
  });

  it('does not reinterpret unsupported node and kind combinations', () => {
    expect(canvasObjectPayload(node('image', { canvasKind: 'shape', shape: 'ellipse' }))).toBeNull();
    expect(canvasObjectPayload(node('canvas-text', { canvasKind: 'shape', shape: 'octagon' }))).toBeNull();
  });
});
