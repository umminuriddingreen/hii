import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceContextAnchor,
  workspaceContextAnchorInstruction,
  workspaceContextAnchorLabel
} from '../../lib/workspace/context-anchor';

describe('workspace context anchors', () => {
  it('normalizes bounded human focus without carrying arbitrary payload fields', () => {
    expect(normalizeWorkspaceContextAnchor({
      kind: 'image-region',
      x: -0.2,
      y: 0.75,
      width: 0.8,
      height: 0.8,
      label: '  Pricing card  ',
      ignored: 'not approved'
    })).toEqual({
      kind: 'image-region',
      x: 0,
      y: 0.75,
      width: 0.8,
      height: 0.25,
      label: 'Pricing card'
    });

    expect(normalizeWorkspaceContextAnchor({
      kind: 'design-selection',
      frame: 'Desktop',
      layers: ['CTA', 'CTA', '', 'Hero']
    })).toEqual({
      kind: 'design-selection',
      frame: 'Desktop',
      layers: ['CTA', 'Hero']
    });
  });

  it('rejects empty or invalid selections and orders page ranges', () => {
    expect(normalizeWorkspaceContextAnchor({ kind: 'media-range', startSeconds: 9, endSeconds: 4 })).toBeUndefined();
    expect(normalizeWorkspaceContextAnchor({ kind: 'design-selection', frame: '', layers: [] })).toBeUndefined();
    expect(normalizeWorkspaceContextAnchor({
      kind: 'document-range',
      pageStart: 8,
      pageEnd: 3
    })).toEqual({
      kind: 'document-range',
      pageStart: 3,
      pageEnd: 8
    });
  });

  it('produces concise UI labels and explicit runner instructions', () => {
    const anchor = normalizeWorkspaceContextAnchor({
      kind: 'drawing-view',
      bounds: { minX: 10, minY: 20, maxX: 80, maxY: 90 },
      layers: ['Walls', 'Doors']
    })!;
    expect(workspaceContextAnchorLabel(anchor)).toBe('saved view · 2 visible layers');
    expect(workspaceContextAnchorInstruction(anchor)).toContain('bounds (10, 20) to (80, 90)');
    expect(workspaceContextAnchorInstruction(anchor)).toContain('"Walls", "Doors"');
  });
});
