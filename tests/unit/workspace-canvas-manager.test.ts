import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LOOSE_BOARD_ID,
  canvasManagerBoards,
  canvasManagerFocusNodes,
  canvasManagerHits
} from '../../lib/workspace/canvas-manager';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(
  id: string,
  type: WorkspaceNode['type'],
  options: {
    title?: string;
    frameId?: string;
    updatedAt?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    url?: string;
    sceneOrder?: number;
  } = {}
): WorkspaceNode {
  return {
    id,
    type,
    x: options.x ?? 0,
    y: options.y ?? 0,
    w: options.w ?? 100,
    h: options.h ?? 100,
    z: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: options.updatedAt ?? '2026-08-01T00:00:00.000Z',
    frameId: options.frameId,
    payload: { title: options.title ?? id, url: options.url, sceneOrder: options.sceneOrder }
  } as WorkspaceNode;
}

describe('canvas manager', () => {
  const rooms = node('rooms', 'frame', { title: 'Room schedule', sceneOrder: 1 });
  const sections = node('sections', 'frame', { title: 'Wall sections', sceneOrder: 2 });
  const nodes = [
    rooms,
    sections,
    node('plan', 'image', { title: 'Level 2 plan', frameId: 'rooms', updatedAt: '2026-08-05T00:00:00.000Z', url: '/a.png' }),
    node('brief', 'note', { title: 'Client brief', frameId: 'rooms' }),
    node('detail', 'cad', { title: 'Parapet detail', frameId: 'sections', updatedAt: '2026-08-09T00:00:00.000Z' }),
    node('stray', 'note', { title: 'Parapet callback', updatedAt: '2026-08-03T00:00:00.000Z' })
  ];

  it('feeds every board newest first and gives loose objects a home', () => {
    const boards = canvasManagerBoards(nodes);
    expect(boards.map((board) => board.id)).toEqual(['sections', 'rooms', LOOSE_BOARD_ID]);
    expect(boards[0]).toMatchObject({ title: 'Wall sections', sequence: 2, memberCount: 1, summary: '1 cad' });
    expect(boards.at(-1)).toMatchObject({ id: LOOSE_BOARD_ID, scene: null, sequence: null, memberCount: 1 });
  });

  it('searches every board at once and attributes each hit to its board', () => {
    const hits = canvasManagerHits(nodes, 'parapet');
    expect(hits.map((hit) => [hit.node.id, hit.boardTitle])).toEqual([
      ['detail', 'Wall sections'],
      ['stray', 'Loose objects']
    ]);
    expect(canvasManagerHits(nodes, '')).toEqual([]);
  });

  it('keeps only boards holding a hit and ranks them by how many', () => {
    const boards = canvasManagerBoards(nodes, 'parapet');
    expect(boards.map((board) => board.id)).toEqual(['sections', LOOSE_BOARD_ID]);
    expect(boards[0].matches.map((match) => match.id)).toEqual(['detail']);
    expect(boards[0].tiles.find((tile) => tile.id === 'detail')?.matched).toBe(true);
  });

  it('normalises preview tiles into the unit box and carries image sources', () => {
    const [, board] = canvasManagerBoards(nodes);
    const tiles = board.tiles;
    expect(board.id).toBe('rooms');
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.w).toBeLessThanOrEqual(1.0001);
      expect(tile.y + tile.h).toBeLessThanOrEqual(1.0001);
    }
    expect(tiles.find((tile) => tile.id === 'plan')?.url).toBe('/a.png');
  });

  it('frames a board together with its contents so an empty board still lands', () => {
    const [sectionsBoard] = canvasManagerBoards(nodes);
    expect(canvasManagerFocusNodes(sectionsBoard).map((entry) => entry.id)).toEqual(['sections', 'detail']);
    const loose = canvasManagerBoards(nodes).find((board) => board.id === LOOSE_BOARD_ID)!;
    expect(canvasManagerFocusNodes(loose).map((entry) => entry.id)).toEqual(['stray']);
  });

  it('caps preview tiles so a huge board cannot outweigh the canvas it summarises', () => {
    const big = [
      node('big', 'frame', { title: 'Big' }),
      ...Array.from({ length: 200 }, (_, index) =>
        node(`n${index}`, 'note', { frameId: 'big', x: index * 10, y: index * 10, w: index + 1, h: index + 1 })
      )
    ];
    const [board] = canvasManagerBoards(big);
    expect(board.memberCount).toBe(200);
    expect(board.tiles).toHaveLength(48);
    expect(board.tiles.every((tile) => tile.w <= 1 && tile.h <= 1)).toBe(true);
  });
});

describe('canvas manager wiring', () => {
  const root = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
  const manager = readFileSync('components/workspace/CanvasManager.tsx', 'utf8');

  it('opens on Escape only once the canvas has nothing left to clear', () => {
    // Escape already cleared selection and tools. If the manager took Escape
    // outright it would swallow that, so the guard is the contract.
    expect(root).toContain('if (drawing || canvasCommandsOpen || selected.length) {');
    expect(root).toContain('openCanvasManager();');
    expect(root).toContain('if (promptVisible || selected.length) { setPromptVisible(false); setSelected([]); return; }');
  });

  it('stops the canvas keymap while the manager owns the screen', () => {
    expect(root).toContain('if (canvasManagerOpen) return;');
    expect(manager).toContain("window.addEventListener('keydown', keydown, { capture: true })");
  });

  it('reaches the boards it lists', () => {
    expect(root).toContain('nodes={workspace.nodes}');
    expect(root).toContain('onFocusBoard={focusCanvasBoard}');
    expect(root).toContain('canvasManagerFocusNodes(board)');
  });

  it('renders a section list so new features slot in without editing the shell', () => {
    expect(manager).toContain('sections = CANVAS_MANAGER_SECTIONS');
    expect(manager).toContain('.filter((entry) => entry.content !== null');
  });
});
