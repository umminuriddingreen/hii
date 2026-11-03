import { describe, expect, it } from 'vitest';
import { organizeContactSheetReviewSet } from '../../lib/workspace/contact-sheet-scene';
import { reverseWorkspaceChange } from '../../lib/workspace/reverse-change';
import { normalizeWorkspace, type WorkspaceDoc, type WorkspaceNode } from '../../lib/workspace/types';

const hashes = ['1', '2', '3'].map((value) => value.padStart(64, '0'));
const items = hashes.map((sha256, index) => ({
  url: `/api/workspace/assets/${index}.png`,
  path: `/project/${index}.png`,
  name: `${index}.png`,
  mime: 'image/png',
  size: 100,
  sha256
}));

function sheet(): WorkspaceNode {
  return {
    id: 'sheet-one',
    type: 'image',
    x: 0,
    y: 0,
    w: 760,
    h: 560,
    z: 1,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    object: {
      kind: 'asset',
      owner: 'human',
      status: 'ready',
      source: 'HII local workspace assets',
      proofRefs: hashes.map((hash) => `sha256:${hash}`)
    },
    payload: {
      adapter: 'contact-sheet',
      title: 'Reference contact sheet',
      items,
      selectedItems: [items[0], items[2]],
      itemLabels: {
        [hashes[0]]: 'facade studies',
        [hashes[2]]: 'facade studies'
      }
    }
  };
}

function document(node: WorkspaceNode): WorkspaceDoc {
  return {
    version: 1,
    revision: 3,
    updatedAt: '2026-07-30T00:00:00.000Z',
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 1,
    nodes: [node]
  };
}

describe('contact-sheet review-set Scenes', () => {
  it('creates a named Scene of exact source-linked child references in an open lane', () => {
    const source = sheet();
    const result = organizeContactSheetReviewSet(document(source), source, {
      sceneId: 'scene-facades',
      now: '2026-07-30T12:00:00.000Z'
    });

    expect(result?.created).toBe(true);
    expect(result?.scene).toMatchObject({
      id: 'scene-facades',
      object: {
        kind: 'scene',
        owner: 'human',
        status: 'ready',
        source: 'HII contact-sheet review set',
        parentId: 'sheet-one',
        proofRefs: [`sha256:${hashes[0]}`, `sha256:${hashes[2]}`]
      },
      payload: {
        adapter: 'contact-sheet-review-scene',
        title: 'facade studies',
        membership: 'contact-sheet-selection',
        sourceContactSheetId: 'sheet-one',
        sourceHashes: [hashes[0], hashes[2]]
      }
    });
    const members = result?.doc.nodes.filter((node) => node.frameId === 'scene-facades') ?? [];
    expect(members).toHaveLength(2);
    expect(members.every((node) =>
      node.type === 'image'
      && node.x > source.x + source.w
      && node.object?.parentId === source.id
      && node.payload.adapter === 'contact-sheet-review-item'
      && node.payload.reviewSceneId === 'scene-facades'
    )).toBe(true);
    expect(members.map((node) => node.payload.sha256)).toEqual([hashes[0], hashes[2]]);
    expect(members.map((node) => node.payload.title)).toEqual(['0.png', '2.png']);
    expect(members.map((node) => node.payload.label)).toEqual(['facade studies', 'facade studies']);
    const persisted = result ? normalizeWorkspace(JSON.parse(JSON.stringify(result.doc))) : null;
    expect(persisted?.nodes.find((node) => node.id === 'scene-facades')).toMatchObject({
      object: { parentId: 'sheet-one', proofRefs: [`sha256:${hashes[0]}`, `sha256:${hashes[2]}`] },
      payload: { adapter: 'contact-sheet-review-scene', sourceContactSheetId: 'sheet-one' }
    });
  });

  it('focuses the existing Scene for the same sheet, membership, and classification', () => {
    const source = sheet();
    source.payload.itemLabels = {};
    const first = organizeContactSheetReviewSet(document(source), source, {
      sceneId: 'scene-facades',
      now: '2026-07-30T12:00:00.000Z'
    });
    const repeated = first ? organizeContactSheetReviewSet(first.doc, source) : null;

    expect(repeated?.created).toBe(false);
    expect(repeated?.scene.id).toBe('scene-facades');
    expect(repeated?.scene.payload.title).toBe('Reference set · 0.png');
    expect(repeated?.doc.nodes).toHaveLength(4);
    expect(repeated?.memberIds).toHaveLength(2);
  });

  it('keeps a newly created review Scene one-step reversible', () => {
    const source = sheet();
    const before = document(source);
    const organized = organizeContactSheetReviewSet(before, source, {
      sceneId: 'scene-facades',
      now: '2026-07-30T12:00:00.000Z'
    });
    const undone = organized ? reverseWorkspaceChange(before, organized.doc, organized.doc) : null;

    expect(undone?.nodes.map(({ updatedAt, ...node }) => node)).toEqual(before.nodes.map(({ updatedAt, ...node }) => node));
    expect(undone?.revision).toBe(before.revision);
  });

  it('requires at least two exact selected references', () => {
    const source = sheet();
    source.payload.selectedItems = [items[0]];
    expect(organizeContactSheetReviewSet(document(source), source)).toBeNull();
  });
});
