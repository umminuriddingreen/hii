export type WorkspaceContextAnchor =
  | {
      kind: 'document-range';
      pageStart: number;
      pageEnd: number;
      note?: string;
    }
  | {
      kind: 'image-region';
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
      note?: string;
    }
  | {
      kind: 'design-selection';
      frame?: string;
      layers: string[];
      note?: string;
    }
  | {
      kind: 'drawing-view';
      bounds: { minX: number; minY: number; maxX: number; maxY: number };
      layers: string[];
      note?: string;
    }
  | {
      kind: 'media-range';
      startSeconds: number;
      endSeconds: number;
      note?: string;
    }
  | {
      kind: 'model-view';
      camera: [number, number, number];
      target: [number, number, number];
      note?: string;
    };

const MAX_MEDIA_SECONDS = 7 * 24 * 60 * 60;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maxLength: number) {
  const normalized = String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized || undefined;
}

function number(value: unknown, min: number, max: number, precision = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const bounded = Math.min(max, Math.max(min, parsed));
  const scale = 10 ** precision;
  return Math.round(bounded * scale) / scale;
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(100_000, Math.max(1, Math.floor(parsed)));
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => text(item, 160))
      .filter((item): item is string => Boolean(item))
      .slice(0, 24)
  )];
}

function vector(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const normalized = value.map((item) => number(item, -1_000_000, 1_000_000, 5));
  return normalized.every((item): item is number => item !== null)
    ? normalized as [number, number, number]
    : null;
}

export function normalizeWorkspaceContextAnchor(value: unknown): WorkspaceContextAnchor | undefined {
  const source = record(value);
  if (!source) return undefined;
  const note = text(source.note, 400);

  if (source.kind === 'document-range') {
    const pageStart = positiveInteger(source.pageStart);
    const pageEnd = positiveInteger(source.pageEnd);
    if (pageStart === null || pageEnd === null) return undefined;
    return {
      kind: 'document-range',
      pageStart: Math.min(pageStart, pageEnd),
      pageEnd: Math.max(pageStart, pageEnd),
      ...(note ? { note } : {})
    };
  }

  if (source.kind === 'image-region') {
    const x = number(source.x, 0, 1);
    const y = number(source.y, 0, 1);
    const width = number(source.width, 0.001, 1);
    const height = number(source.height, 0.001, 1);
    if (x === null || y === null || width === null || height === null) return undefined;
    const boundedWidth = Math.min(width, 1 - x);
    const boundedHeight = Math.min(height, 1 - y);
    if (boundedWidth < 0.001 || boundedHeight < 0.001) return undefined;
    const label = text(source.label, 160);
    return {
      kind: 'image-region',
      x,
      y,
      width: boundedWidth,
      height: boundedHeight,
      ...(label ? { label } : {}),
      ...(note ? { note } : {})
    };
  }

  if (source.kind === 'design-selection') {
    const frame = text(source.frame, 160);
    const layers = stringList(source.layers);
    if (!frame && !layers.length) return undefined;
    return {
      kind: 'design-selection',
      ...(frame ? { frame } : {}),
      layers,
      ...(note ? { note } : {})
    };
  }

  if (source.kind === 'drawing-view') {
    const rawBounds = record(source.bounds);
    if (!rawBounds) return undefined;
    const minX = number(rawBounds.minX, -1_000_000_000, 1_000_000_000, 5);
    const minY = number(rawBounds.minY, -1_000_000_000, 1_000_000_000, 5);
    const maxX = number(rawBounds.maxX, -1_000_000_000, 1_000_000_000, 5);
    const maxY = number(rawBounds.maxY, -1_000_000_000, 1_000_000_000, 5);
    if ([minX, minY, maxX, maxY].some((item) => item === null)) return undefined;
    if (maxX! <= minX! || maxY! <= minY!) return undefined;
    return {
      kind: 'drawing-view',
      bounds: { minX: minX!, minY: minY!, maxX: maxX!, maxY: maxY! },
      layers: stringList(source.layers),
      ...(note ? { note } : {})
    };
  }

  if (source.kind === 'media-range') {
    const startSeconds = number(source.startSeconds, 0, MAX_MEDIA_SECONDS, 3);
    const endSeconds = number(source.endSeconds, 0, MAX_MEDIA_SECONDS, 3);
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) return undefined;
    return {
      kind: 'media-range',
      startSeconds,
      endSeconds,
      ...(note ? { note } : {})
    };
  }

  if (source.kind === 'model-view') {
    const camera = vector(source.camera);
    const target = vector(source.target);
    if (!camera || !target) return undefined;
    return {
      kind: 'model-view',
      camera,
      target,
      ...(note ? { note } : {})
    };
  }

  return undefined;
}

function secondsLabel(value: number) {
  const total = Math.max(0, value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const rawSeconds = seconds.toFixed(seconds % 1 ? 1 : 0);
  const secondText = rawSeconds.padStart(rawSeconds.includes('.') ? 4 : 2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondText.padStart(2, '0')}`
    : `${minutes}:${secondText}`;
}

function compactNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

export function workspaceContextAnchorLabel(anchor: WorkspaceContextAnchor) {
  if (anchor.kind === 'document-range') {
    return anchor.pageStart === anchor.pageEnd
      ? `page ${anchor.pageStart}`
      : `pages ${anchor.pageStart}–${anchor.pageEnd}`;
  }
  if (anchor.kind === 'image-region') {
    return anchor.label || `region ${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}% · ${Math.round(anchor.width * 100)}% × ${Math.round(anchor.height * 100)}%`;
  }
  if (anchor.kind === 'design-selection') {
    return [
      anchor.frame ? `frame ${anchor.frame}` : '',
      anchor.layers.length ? `${anchor.layers.length} layer${anchor.layers.length === 1 ? '' : 's'}` : ''
    ].filter(Boolean).join(' · ');
  }
  if (anchor.kind === 'drawing-view') {
    return `saved view${anchor.layers.length ? ` · ${anchor.layers.length} visible layer${anchor.layers.length === 1 ? '' : 's'}` : ''}`;
  }
  if (anchor.kind === 'media-range') {
    return `${secondsLabel(anchor.startSeconds)}–${secondsLabel(anchor.endSeconds)}`;
  }
  return 'saved 3D view';
}

export function workspaceContextAnchorInstruction(anchor: WorkspaceContextAnchor) {
  const note = anchor.note ? ` Human note: ${anchor.note}` : '';
  if (anchor.kind === 'document-range') {
    return `Human-reviewed PDF focus: ${workspaceContextAnchorLabel(anchor)}. Treat only this page range as the selected region.${note}`;
  }
  if (anchor.kind === 'image-region') {
    return `Human-reviewed image focus: normalized crop x=${compactNumber(anchor.x)}, y=${compactNumber(anchor.y)}, width=${compactNumber(anchor.width)}, height=${compactNumber(anchor.height)}${anchor.label ? ` (${anchor.label})` : ''}.${note}`;
  }
  if (anchor.kind === 'design-selection') {
    return `Human-reviewed design focus: ${anchor.frame ? `frame "${anchor.frame}"` : 'no named frame'}${anchor.layers.length ? `; layers ${anchor.layers.map((layer) => `"${layer}"`).join(', ')}` : ''}.${note}`;
  }
  if (anchor.kind === 'drawing-view') {
    const { minX, minY, maxX, maxY } = anchor.bounds;
    return `Human-reviewed drawing focus: bounds (${compactNumber(minX)}, ${compactNumber(minY)}) to (${compactNumber(maxX)}, ${compactNumber(maxY)})${anchor.layers.length ? `; visible layers ${anchor.layers.map((layer) => `"${layer}"`).join(', ')}` : ''}.${note}`;
  }
  if (anchor.kind === 'media-range') {
    return `Human-reviewed media focus: ${workspaceContextAnchorLabel(anchor)} (${compactNumber(anchor.startSeconds)}s to ${compactNumber(anchor.endSeconds)}s).${note}`;
  }
  return `Human-reviewed 3D view: camera [${anchor.camera.map(compactNumber).join(', ')}], target [${anchor.target.map(compactNumber).join(', ')}].${note}`;
}
