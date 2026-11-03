import { searchWorkspaceNodes, workspaceNodeTitle } from './search.ts';
import { workspaceSceneTypeSummary, workspaceScenes } from './scenes.ts';
import type { WorkspaceNode } from './types.ts';

/**
 * The canvas manager is the view you get by pressing Escape on an idle canvas:
 * every board at once, searchable in one field, scrollable as a feed.
 *
 * The canvas itself is a single spatial document — "boards" are its frames — so
 * searching across boards is searching the whole document and then attributing
 * each hit back to the frame that contains it. That attribution is what makes a
 * flat hit list navigable, and it is the only thing this module adds over
 * `searchWorkspaceNodes`.
 */

/** Objects that belong to no frame still need a home in the feed. */
export const LOOSE_BOARD_ID = 'loose-objects';

/**
 * Tiles per preview. A board can hold thousands of objects; a card that mounted
 * one element each would cost more than the canvas it is summarising.
 */
const PREVIEW_TILE_LIMIT = 48;

export type CanvasManagerTile = {
  id: string;
  type: string;
  /** Position within the preview box, normalised to 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Set for image-like objects so a card can show the real thing. */
  url: string;
  matched: boolean;
};

export type CanvasManagerBoard = {
  id: string;
  title: string;
  /** The frame node, or null for the loose-objects board, which has none. */
  scene: WorkspaceNode | null;
  sequence: number | null;
  members: WorkspaceNode[];
  memberCount: number;
  summary: string;
  updatedAt: string;
  /** Members matching the active query; empty when no query is active. */
  matches: WorkspaceNode[];
  tiles: CanvasManagerTile[];
};

export type CanvasManagerHit = {
  node: WorkspaceNode;
  title: string;
  boardId: string;
  boardTitle: string;
};

function latest(nodes: WorkspaceNode[], seed = '') {
  return nodes.reduce((newest, node) => (node.updatedAt > newest ? node.updatedAt : newest), seed);
}

function imageUrl(node: WorkspaceNode) {
  if (node.type !== 'image') return '';
  const url = node.payload.url;
  return typeof url === 'string' ? url : '';
}

/**
 * Members laid out inside a unit square, preserving their relative positions so
 * the card reads as a small picture of the board rather than a list.
 */
function previewTiles(members: WorkspaceNode[], matched: Set<string>): CanvasManagerTile[] {
  if (!members.length) return [];
  // Keep the largest objects: they carry the board's shape, and a matched
  // object is kept regardless so a search hit is always visible on its card.
  const kept = [...members]
    .sort((left, right) => {
      const priority = Number(matched.has(right.id)) - Number(matched.has(left.id));
      return priority || right.w * right.h - left.w * left.h;
    })
    .slice(0, PREVIEW_TILE_LIMIT);

  const left = Math.min(...kept.map((node) => node.x));
  const top = Math.min(...kept.map((node) => node.y));
  const right = Math.max(...kept.map((node) => node.x + node.w));
  const bottom = Math.max(...kept.map((node) => node.y + node.h));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  return kept.map((node) => ({
    id: node.id,
    type: node.type,
    x: (node.x - left) / width,
    y: (node.y - top) / height,
    w: Math.min(1, node.w / width),
    h: Math.min(1, node.h / height),
    url: imageUrl(node),
    matched: matched.has(node.id)
  }));
}

function groupMembers(nodes: WorkspaceNode[]) {
  const scenes = workspaceScenes(nodes);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const byScene = new Map<string, WorkspaceNode[]>();
  const loose: WorkspaceNode[] = [];

  for (const node of nodes) {
    if (node.type === 'frame') continue;
    const sceneId = node.frameId && sceneIds.has(node.frameId) ? node.frameId : null;
    if (!sceneId) {
      loose.push(node);
      continue;
    }
    byScene.set(sceneId, [...(byScene.get(sceneId) ?? []), node]);
  }
  return { scenes, byScene, loose };
}

/**
 * Every board, newest activity first, or — with a query — only the boards that
 * contain a hit, ranked by how many.
 */
export function canvasManagerBoards(nodes: WorkspaceNode[], query = ''): CanvasManagerBoard[] {
  const { scenes, byScene, loose } = groupMembers(nodes);
  const active = query.trim().length > 0;

  const build = (
    id: string,
    title: string,
    scene: WorkspaceNode | null,
    sequence: number | null,
    members: WorkspaceNode[]
  ): CanvasManagerBoard => {
    const matches = active
      ? searchWorkspaceNodes(members, query, members.length).map((result) => result.node)
      : [];
    const matched = new Set(matches.map((node) => node.id));
    return {
      id,
      title,
      scene,
      sequence,
      members,
      memberCount: members.length,
      summary: workspaceSceneTypeSummary(members),
      updatedAt: latest(members, scene?.updatedAt ?? ''),
      matches,
      tiles: previewTiles(members, matched)
    };
  };

  const boards = scenes.map((scene, index) =>
    build(scene.id, workspaceNodeTitle(scene), scene, index + 1, byScene.get(scene.id) ?? [])
  );
  if (loose.length) boards.push(build(LOOSE_BOARD_ID, 'Loose objects', null, null, loose));

  if (!active) return boards.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return boards
    .filter((board) => board.matches.length > 0)
    .sort((left, right) => right.matches.length - left.matches.length
      || right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * One flat, ranked list of hits across every board — the "search all boards at
 * once" result — with each hit carrying the board it lives on.
 */
export function canvasManagerHits(nodes: WorkspaceNode[], query: string, limit = 24): CanvasManagerHit[] {
  if (!query.trim()) return [];
  const { scenes, byScene, loose } = groupMembers(nodes);
  const boardOf = new Map<string, { id: string; title: string }>();
  for (const scene of scenes) {
    const board = { id: scene.id, title: workspaceNodeTitle(scene) };
    for (const member of byScene.get(scene.id) ?? []) boardOf.set(member.id, board);
  }
  const looseBoard = { id: LOOSE_BOARD_ID, title: 'Loose objects' };
  for (const node of loose) boardOf.set(node.id, looseBoard);

  const searchable = nodes.filter((node) => node.type !== 'frame');
  return searchWorkspaceNodes(searchable, query, limit).map((result) => {
    const board = boardOf.get(result.node.id) ?? looseBoard;
    return { node: result.node, title: result.title, boardId: board.id, boardTitle: board.title };
  });
}

/**
 * The nodes a jump should frame. Boards frame themselves plus their contents so
 * an empty board still has somewhere to land.
 */
export function canvasManagerFocusNodes(board: CanvasManagerBoard): WorkspaceNode[] {
  return board.scene ? [board.scene, ...board.members] : board.members;
}
