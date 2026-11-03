import type { WorkspaceNode } from './types.ts';

export type CanvasShapeKind =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'hexagon'
  | 'arrow'
  | 'cloud';

export type CanvasAppearance = {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: 'left' | 'center' | 'right';
  listStyle?: 'none' | 'bullet' | 'number';
  foreground?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
};

export type CanvasTable = {
  rows: string[][];
  headerRow?: boolean;
};

export type CanvasObjectState = {
  appearance?: CanvasAppearance;
  groupId?: string;
  locked?: boolean;
};

export type CanvasObjectPayload =
  | (CanvasObjectState & { canvasKind: 'text'; content?: string })
  | (CanvasObjectState & { canvasKind: 'shape'; shape: CanvasShapeKind; content?: string })
  | (CanvasObjectState & { canvasKind: 'sticky'; content?: string })
  | (CanvasObjectState & { canvasKind: 'table'; table: CanvasTable; content?: string });

const shapeKinds = new Set<CanvasShapeKind>([
  'rectangle',
  'rounded-rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'arrow',
  'cloud'
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = 100_000) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function finite(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : undefined;
}

function appearance(value: unknown): CanvasAppearance | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const normalized: CanvasAppearance = {
    fontFamily: text(raw.fontFamily, 120),
    fontSize: finite(raw.fontSize, 6, 512),
    fontWeight: finite(raw.fontWeight, 100, 900),
    textAlign: raw.textAlign === 'center' || raw.textAlign === 'right' ? raw.textAlign : raw.textAlign === 'left' ? 'left' : undefined,
    listStyle: raw.listStyle === 'bullet' || raw.listStyle === 'number' ? raw.listStyle : raw.listStyle === 'none' ? 'none' : undefined,
    foreground: text(raw.foreground, 80),
    fill: text(raw.fill, 80),
    stroke: text(raw.stroke, 80),
    strokeWidth: finite(raw.strokeWidth, 0, 64),
    opacity: finite(raw.opacity, 0, 1)
  };
  return Object.values(normalized).some((entry) => entry !== undefined) ? normalized : undefined;
}

function table(value: unknown): CanvasTable | undefined {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.rows)) return undefined;
  const rows = raw.rows.slice(0, 200).map((row) =>
    Array.isArray(row) ? row.slice(0, 100).map((cell) => String(cell ?? '').slice(0, 10_000)) : []
  );
  if (!rows.length) return undefined;
  return { rows, headerRow: raw.headerRow === true || undefined };
}

/**
 * Read the optional Freeform-class payload envelope without changing legacy
 * node types or WorkspaceDoc version. Unknown payload fields remain untouched.
 */
export function canvasObjectPayload(node: Pick<WorkspaceNode, 'type' | 'payload'>): CanvasObjectPayload | null {
  const raw = record(node.payload);
  if (!raw) return null;
  const common = canvasObjectState(node);
  const content = text(raw.content);
  if (node.type === 'canvas-text' && raw.canvasKind === 'text') return { ...common, canvasKind: 'text', content };
  if (node.type === 'canvas-text' && raw.canvasKind === 'shape' && shapeKinds.has(raw.shape as CanvasShapeKind)) {
    return { ...common, canvasKind: 'shape', shape: raw.shape as CanvasShapeKind, content };
  }
  if (node.type === 'note' && raw.canvasKind === 'sticky') return { ...common, canvasKind: 'sticky', content };
  if (node.type === 'note' && raw.canvasKind === 'table') {
    const normalizedTable = table(raw.table);
    if (normalizedTable) return { ...common, canvasKind: 'table', table: normalizedTable, content };
  }
  return null;
}

/** Grouping, locking, and appearance apply to every durable canvas object. */
export function canvasObjectState(node: Pick<WorkspaceNode, 'payload'>): CanvasObjectState {
  const raw = record(node.payload) || {};
  return {
    appearance: appearance(raw.appearance),
    groupId: text(raw.groupId, 64),
    locked: raw.locked === true || undefined
  };
}

export function canvasTableText(value: CanvasTable) {
  return value.rows.map((row) => row.join('\t')).join('\n');
}

export function canvasObjectContextText(node: Pick<WorkspaceNode, 'type' | 'payload'>) {
  const payload = canvasObjectPayload(node);
  if (!payload) return '';
  if (payload.canvasKind === 'table') return canvasTableText(payload.table);
  return payload.content || '';
}
