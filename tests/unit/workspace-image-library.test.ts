import { describe, expect, it } from 'vitest';
import { filterImageLibrary, workspaceImageLibrary } from '../../lib/workspace/image-library';
import type { WorkspaceNode } from '../../lib/workspace/types';

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const A = hash('a');
const B = hash('b');

const item = (sha256: string, name: string) => ({
  url: `/assets/${name}`,
  path: `/vault/${name}`,
  name,
  mime: 'image/png',
  size: 1_024,
  sha256
});

const node = (id: string, payload: Record<string, unknown>, type = 'image'): WorkspaceNode => ({
  id,
  type,
  x: 0,
  y: 0,
  w: 200,
  h: 150,
  z: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload
} as WorkspaceNode);

describe('workspace image library', () => {
  it('flattens images out of the contact sheets holding them', () => {
    const library = workspaceImageLibrary([
      node('sheet', { adapter: 'contact-sheet', items: [item(A, 'one.png'), item(B, 'two.png')] })
    ]);
    expect(library.map((image) => image.name).sort()).toEqual(['one.png', 'two.png']);
    expect(library.every((image) => image.sourceId === 'sheet')).toBe(true);
  });

  it('deduplicates the same image across several sheets', () => {
    const library = workspaceImageLibrary([
      node('sheet1', { adapter: 'contact-sheet', items: [item(A, 'one.png')] }),
      node('sheet2', { adapter: 'contact-sheet', items: [item(A, 'one-copy.png')] })
    ]);
    expect(library).toHaveLength(1);
  });

  it('marks which references are already placed on the board', () => {
    const library = workspaceImageLibrary([
      node('sheet', { adapter: 'contact-sheet', items: [item(A, 'one.png'), item(B, 'two.png')] }),
      node('placed', item(A, 'one.png'))
    ]);
    expect(library.find((image) => image.sha256 === A)?.onBoard).toBe(true);
    expect(library.find((image) => image.sha256 === B)?.onBoard).toBe(false);
  });

  it('includes standalone image nodes that never came from a sheet', () => {
    const library = workspaceImageLibrary([node('solo', item(B, 'solo.png'))]);
    expect(library.map((image) => image.name)).toEqual(['solo.png']);
    expect(library[0].onBoard).toBe(true);
  });

  it('ignores nodes that are not images at all', () => {
    expect(workspaceImageLibrary([node('note', { content: 'hello' }, 'note')])).toEqual([]);
  });

  it('drops entries with no durable content hash to point at', () => {
    const library = workspaceImageLibrary([
      node('sheet', { adapter: 'contact-sheet', items: [{ ...item(A, 'ok.png') }, { name: 'ghost.png' }] })
    ]);
    expect(library).toHaveLength(1);
  });
});

describe('filtering the library', () => {
  const images = workspaceImageLibrary([
    node('sheet', { adapter: 'contact-sheet', items: [item(A, 'facade-study.png'), item(B, 'roof-plan.png')] })
  ]);

  it('matches on file name, case-insensitively', () => {
    expect(filterImageLibrary(images, 'FACADE').map((image) => image.name)).toEqual(['facade-study.png']);
  });

  it('returns everything for an empty query', () => {
    expect(filterImageLibrary(images, '   ')).toHaveLength(2);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterImageLibrary(images, 'nonexistent')).toEqual([]);
  });
});
