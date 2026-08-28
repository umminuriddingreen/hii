import { describe, expect, it } from 'vitest';
import { SPACE_SURFACE_CAPABILITIES, isSpaceCanvasNode, isSpaceCanvasNodeType, spaceIdFromPathname, spaceStorageKey } from '@/components/spaces/space-surface';

describe('Spaces reduced surface', () => {
  it('recognizes a canonical Space route without changing the Workspace route', () => {
    expect(spaceIdFromPathname('/s/14th-street')).toBe('14th-street');
    expect(spaceIdFromPathname('/')).toBeNull();
    expect(spaceIdFromPathname('/s/../../private')).toBeNull();
  });

  it('excludes privileged Workspace capabilities and nodes', () => {
    expect(SPACE_SURFACE_CAPABILITIES).toMatchObject({ image: true, drawing: true, terminal: false, browser: false, agents: false, receipts: false });
    expect(isSpaceCanvasNodeType('canvas-text')).toBe(true);
    expect(isSpaceCanvasNodeType('image')).toBe(true);
    expect(isSpaceCanvasNodeType('link')).toBe(false);
    expect(isSpaceCanvasNodeType('html')).toBe(false);
    expect(isSpaceCanvasNode({ type: 'image', spaceId: 'place' }, 'place')).toBe(true);
    expect(isSpaceCanvasNode({ type: 'terminal', spaceId: 'place' }, 'place')).toBe(false);
    expect(isSpaceCanvasNode({ type: 'image', spaceId: 'private-workspace' }, 'place')).toBe(false);
  });

  it('uses a Space-specific browser key instead of the Workspace key', () => {
    expect(spaceStorageKey('place')).toBe('hii.space.workspace.place.v1');
    expect(spaceStorageKey('place')).not.toBe('hii.workspace.v2');
  });
});
