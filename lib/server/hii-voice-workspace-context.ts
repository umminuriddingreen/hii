import { readWorkspace } from './workspace-store.ts';
import { normalizeWorkspaceRunContext, type WorkspaceRunContextItem } from './hii-workspace-run-context.ts';
import { workspaceNodeContextItems } from '../workspace/context-item.ts';
import { workspaceNodeTitle } from '../workspace/search.ts';
import type { WorkspaceNode } from '../workspace/types.ts';

/**
 * What a voice caller claims the human had selected when they spoke.
 *
 * Nothing here is trusted. Every identifier is resolved against the persisted
 * workspace document, which remains the authority, and anything that does not
 * resolve is reported rather than invented.
 */
export type VoiceWorkspaceSelection = {
  workspaceId?: string;
  nodeIds?: string[];
  sceneId?: string;
  selectedText?: string;
};

export type VoiceWorkspaceContext = {
  /** Empty when no workspace could be read. */
  workspaceId: string;
  workspaceRevision: number;
  available: boolean;
  /** Context entries resolved from real nodes in the persisted workspace. */
  items: WorkspaceRunContextItem[];
  /** Requested node ids that are not present in the workspace. */
  unresolvedNodeIds: string[];
  selectedNodeIds: string[];
  sceneId?: string;
  sceneTitle?: string;
  selectedText?: string;
  notice: string;
};

function cleanText(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanNodeId(value: unknown) {
  return cleanText(value, 120).replace(/[^a-zA-Z0-9_-]/g, '');
}

export function normalizeVoiceWorkspaceSelection(value: unknown): VoiceWorkspaceSelection {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const nodeIds = Array.isArray(raw.nodeIds)
    ? Array.from(new Set(raw.nodeIds.map(cleanNodeId).filter(Boolean))).slice(0, 24)
    : [];
  const workspaceId = cleanText(raw.workspaceId, 120).replace(/[^a-zA-Z0-9_-]/g, '');
  const sceneId = cleanNodeId(raw.sceneId);
  const selectedText = cleanText(raw.selectedText, 2400);
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(nodeIds.length ? { nodeIds } : {}),
    ...(sceneId ? { sceneId } : {}),
    ...(selectedText ? { selectedText } : {})
  };
}

function emptyContext(notice: string): VoiceWorkspaceContext {
  return {
    workspaceId: '',
    workspaceRevision: 0,
    available: false,
    items: [],
    unresolvedNodeIds: [],
    selectedNodeIds: [],
    notice
  };
}

/**
 * Resolves a spoken selection into the same context entries the spatial
 * workspace would have produced for those nodes.
 */
export async function resolveVoiceWorkspaceContext(
  selection: VoiceWorkspaceSelection
): Promise<VoiceWorkspaceContext> {
  const requestedNodeIds = selection.nodeIds ?? [];
  let doc;
  let workspaceId = selection.workspaceId ?? '';
  try {
    doc = await readWorkspace(selection.workspaceId);
    workspaceId = selection.workspaceId || workspaceId;
  } catch (error) {
    return emptyContext(
      `No workspace context: ${error instanceof Error ? cleanText(error.message, 240) : 'workspace unavailable'}.`
    );
  }

  const byId = new Map<string, WorkspaceNode>(doc.nodes.map((node) => [node.id, node]));
  const resolvedNodes: WorkspaceNode[] = [];
  const unresolvedNodeIds: string[] = [];
  for (const nodeId of requestedNodeIds) {
    const node = byId.get(nodeId);
    if (node) resolvedNodes.push(node);
    else unresolvedNodeIds.push(nodeId);
  }

  const items = normalizeWorkspaceRunContext(resolvedNodes.flatMap(workspaceNodeContextItems));
  const scene = selection.sceneId ? byId.get(selection.sceneId) : undefined;

  const notice = !requestedNodeIds.length
    ? 'No workspace objects were selected when this was spoken.'
    : unresolvedNodeIds.length
      ? `${items.length} of ${requestedNodeIds.length} selected object${requestedNodeIds.length === 1 ? '' : 's'} resolved; ${unresolvedNodeIds.length} could not be found in this workspace.`
      : `${items.length} selected workspace object${items.length === 1 ? '' : 's'} resolved.`;

  return {
    workspaceId,
    workspaceRevision: doc.revision,
    available: true,
    items,
    unresolvedNodeIds,
    selectedNodeIds: resolvedNodes.map((node) => node.id),
    ...(scene ? { sceneId: scene.id, sceneTitle: workspaceNodeTitle(scene) } : {}),
    ...(selection.selectedText ? { selectedText: selection.selectedText } : {}),
    notice
  };
}
