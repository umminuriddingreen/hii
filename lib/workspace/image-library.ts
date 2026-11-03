import { normalizeContactSheetItems, type ContactSheetItem } from './contact-sheet';
import type { WorkspaceNode } from './types';

export type LibraryImage = ContactSheetItem & {
  /** The contact sheet or image node this came from. */
  sourceId: string;
  /** True when this image is already placed on the board as its own node. */
  onBoard: boolean;
};

/**
 * Every image the workspace knows about, from both contact sheets and
 * standalone image nodes, deduplicated by content hash.
 *
 * Images arrive in bulk and then hide inside whichever contact sheet absorbed
 * them. This is the flat view — a library you can browse and pull from — rather
 * than making the user remember which sheet holds what.
 */
export function workspaceImageLibrary(nodes: WorkspaceNode[]): LibraryImage[] {
  const placed = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'image' || node.payload.adapter === 'contact-sheet') continue;
    const sha256 = String(node.payload.sha256 || '');
    if (sha256) placed.add(sha256);
  }

  const byHash = new Map<string, LibraryImage>();

  for (const node of nodes) {
    if (node.type !== 'image') continue;
    if (node.payload.adapter === 'contact-sheet') {
      for (const item of normalizeContactSheetItems(node.payload.items)) {
        if (byHash.has(item.sha256)) continue;
        byHash.set(item.sha256, { ...item, sourceId: node.id, onBoard: placed.has(item.sha256) });
      }
      continue;
    }
    // A standalone image node describes itself in the same shape.
    const [item] = normalizeContactSheetItems([node.payload]);
    if (!item || byHash.has(item.sha256)) continue;
    byHash.set(item.sha256, { ...item, sourceId: node.id, onBoard: true });
  }

  return [...byHash.values()];
}

/** Filter the library by a free-text query over file names. */
export function filterImageLibrary(images: LibraryImage[], query: string): LibraryImage[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return images;
  return images.filter((image) => image.name.toLowerCase().includes(needle)
    || image.path.toLowerCase().includes(needle));
}
