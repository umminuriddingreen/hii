import type { WorkspaceNode } from './types';

export type ParametricLayoutKind = 'field' | 'grid' | 'chronology' | 'constellation';

export type ParametricLayoutOptions = {
  layout: ParametricLayoutKind;
  spacing: number;
  scale: number;
  origin: { x: number; y: number };
};

export type ParametricNodePlacement = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

function metadata(node: WorkspaceNode, key: string) {
  const value = node.payload[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function ordered(nodes: WorkspaceNode[], layout: ParametricLayoutKind) {
  if (layout !== 'chronology') return [...nodes];
  return [...nodes].sort((a, b) => {
    const year = metadata(a, 'year').localeCompare(metadata(b, 'year'), undefined, { numeric: true });
    return year || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

export function parametricImageLayout(nodes: WorkspaceNode[], options: ParametricLayoutOptions): ParametricNodePlacement[] {
  const images = ordered(nodes.filter((node) => node.type === 'image'), options.layout);
  if (!images.length) return [];
  const scale = Math.max(.35, Math.min(2, options.scale));
  const gap = Math.max(12, Math.min(320, options.spacing));
  const baseWidth = 260 * scale;
  const baseHeight = 196 * scale;
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length)));
  const rows = Math.ceil(images.length / columns);

  return images.map((node, index) => {
    let x = 0;
    let y = 0;
    if (options.layout === 'constellation') {
      if (index > 0) {
        const ring = Math.ceil(Math.sqrt(index));
        const slots = ring * 6;
        const angle = ((index - 1) % slots) / slots * Math.PI * 2 - Math.PI / 2;
        const radius = ring * (baseWidth + gap) * .72;
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
      }
    } else if (options.layout === 'field') {
      const column = index % columns;
      const row = Math.floor(index / columns);
      x = (column - (columns - 1) / 2) * (baseWidth + gap);
      y = (row - (rows - 1) / 2) * (baseHeight + gap) + Math.sin((index + 1) * 1.7) * gap * .65;
    } else if (options.layout === 'chronology') {
      x = (index - (images.length - 1) / 2) * (baseWidth + gap);
    } else {
      const column = index % columns;
      const row = Math.floor(index / columns);
      x = (column - (columns - 1) / 2) * (baseWidth + gap);
      y = (row - (rows - 1) / 2) * (baseHeight + gap);
    }
    return { id: node.id, x: options.origin.x + x, y: options.origin.y + y, w: baseWidth, h: baseHeight };
  });
}
