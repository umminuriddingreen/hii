import { workspaceScenes } from './scenes.ts';
import type { SpatialAuditEntry, WorkspaceDoc, WorkspaceNode } from './types.ts';

export type WorkspaceSelectionOrganization = {
  doc: WorkspaceDoc;
  scene: WorkspaceNode;
  organizedIds: string[];
};

export type WorkspaceSelectionOrganizationOptions = {
  sceneId?: string;
  title?: string;
  now?: string;
};

const HORIZONTAL_PADDING = 32;
const TOP_PADDING = 56;
const BOTTOM_PADDING = 32;
const MIN_SCENE_WIDTH = 360;
const MIN_SCENE_HEIGHT = 240;

function selectedOrganizableNodes(doc: WorkspaceDoc, selectedIds: string[]) {
  const selected = new Set(selectedIds);
  return doc.nodes.filter((node) => selected.has(node.id) && node.type !== 'frame');
}

function selectionTypeSummary(nodes: WorkspaceNode[]) {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const kind = node.object?.kind || node.type;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
}

export function organizeWorkspaceSelection(
  doc: WorkspaceDoc,
  selectedIds: string[],
  options: WorkspaceSelectionOrganizationOptions = {}
): WorkspaceSelectionOrganization | null {
  const members = selectedOrganizableNodes(doc, selectedIds);
  if (members.length < 2) return null;

  const existingScenes = workspaceScenes(doc.nodes);
  const sceneNumber = existingScenes.reduce((highest, scene) => {
    const order = scene.payload.sceneOrder;
    return typeof order === 'number' && Number.isFinite(order) ? Math.max(highest, order) : highest;
  }, existingScenes.length) + 1;
  const now = options.now && Number.isFinite(new Date(options.now).getTime())
    ? new Date(options.now).toISOString()
    : new Date().toISOString();
  const sceneId = options.sceneId?.trim() || crypto.randomUUID();
  if (doc.nodes.some((node) => node.id === sceneId)) throw new Error('Scene id already exists.');

  const left = Math.min(...members.map((node) => node.x));
  const top = Math.min(...members.map((node) => node.y));
  const right = Math.max(...members.map((node) => node.x + node.w));
  const bottom = Math.max(...members.map((node) => node.y + node.h));
  const memberIds = new Set(members.map((node) => node.id));
  const organizedIds = members.map((node) => node.id);
  const audit: SpatialAuditEntry[] = [{
    ts: now,
    actor: 'human',
    action: 'organized explicit workspace selection into scene',
    note: `${members.length} selected objects · ${selectionTypeSummary(members)}`
  }];
  const scene: WorkspaceNode = {
    id: sceneId,
    type: 'frame',
    x: left - HORIZONTAL_PADDING,
    y: top - TOP_PADDING,
    w: Math.max(MIN_SCENE_WIDTH, right - left + HORIZONTAL_PADDING * 2),
    h: Math.max(MIN_SCENE_HEIGHT, bottom - top + TOP_PADDING + BOTTOM_PADDING),
    z: Math.min(...members.map((node) => node.z)) - 1,
    createdAt: now,
    updatedAt: now,
    object: {
      kind: 'scene',
      owner: 'human',
      status: 'ready',
      source: 'HII explicit workspace selection',
      capabilityId: 'hii.workspace.creative_canvas',
      audit
    },
    payload: {
      title: options.title?.trim() || `Scene ${sceneNumber}`,
      collapsed: false,
      sceneOrder: sceneNumber,
      membership: 'explicit-selection',
      memberCount: members.length
    }
  };

  return {
    scene,
    organizedIds,
    doc: {
      ...doc,
      updatedAt: now,
      nodes: [
        scene,
        ...doc.nodes.map((node) => memberIds.has(node.id)
          ? { ...node, frameId: sceneId, updatedAt: now }
          : node)
      ]
    }
  };
}
