import type { WorkspaceNode } from './types.ts';
import { workspaceNodeTitle } from './search.ts';
import { normalizeWorkspaceContextAnchor } from './context-anchor.ts';
import { contactSheetContextItems } from './contact-sheet.ts';
import { canvasObjectContextText } from './canvas-objects.ts';

/**
 * Builds the context descriptor a workspace node contributes to a run.
 *
 * Shared so the spatial workspace and the voice runtime describe the same node
 * identically. Two builders would let an approved manifest disagree with what
 * the human reviewed depending on which surface started the run.
 */
export function workspaceNodeContextExcerpt(node: WorkspaceNode) {
  const candidates = [
    canvasObjectContextText(node),
    node.payload.content,
    node.payload.text,
    node.payload.summary,
    node.payload.description,
    node.payload.markdown
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

export function workspaceNodeContextItem(node: WorkspaceNode) {
  return {
    id: node.id,
    title: workspaceNodeTitle(node),
    type: node.type,
    source: String(node.payload.path || node.payload.url || node.object?.source || '').slice(0, 1000),
    expectedSha256: String(node.payload.sha256 || '').slice(0, 64),
    anchor: normalizeWorkspaceContextAnchor(node.payload.contextAnchor),
    excerpt: workspaceNodeContextExcerpt(node),
    objectKind: String(node.object?.kind || ''),
    owner: String(node.object?.owner || ''),
    authority: String(node.objectRef?.authority || ''),
    proofRefs: (node.object?.proofRefs || []).slice(0, 12)
  };
}

/**
 * Expands a node into the context entries it actually contributes. A contact
 * sheet contributes its selected items rather than the sheet itself.
 */
export function workspaceNodeContextItems(node: WorkspaceNode) {
  if (node.payload.adapter === 'contact-sheet') {
    const selected = contactSheetContextItems({
      nodeId: node.id,
      items: node.payload.items,
      selectedItems: node.payload.selectedItems,
      itemLabels: node.payload.itemLabels,
      proofRefs: node.object?.proofRefs
    });
    if (selected.length) return selected;
  }
  return [workspaceNodeContextItem(node)];
}
