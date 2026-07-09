export type CanvasNodeType =
  | 'note'
  | 'text'
  | 'link'
  | 'file'
  | 'image'
  | 'media'
  | 'html'
  | 'font'
  | 'terminal'
  | 'browser'
  | 'context'
  | 'board'
  | 'job';

export const canvasNodeTypes: CanvasNodeType[] = [
  'note',
  'text',
  'link',
  'file',
  'image',
  'media',
  'html',
  'font',
  'terminal',
  'browser',
  'context',
  'board',
  'job'
];

export type CanvasNode = {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
};

export type WorkspaceViewport = { x: number; y: number; zoom: number };

export type WorkspaceDoc = {
  version: 1;
  updatedAt: string;
  viewport: WorkspaceViewport;
  nextZ: number;
  nodes: CanvasNode[];
};

export function emptyWorkspace(): WorkspaceDoc {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 1,
    nodes: []
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.id !== 'string' || !node.id) return null;
  if (!canvasNodeTypes.includes(node.type as CanvasNodeType)) return null;
  if (![node.x, node.y, node.w, node.h].every(isFiniteNumber)) return null;
  const now = new Date().toISOString();
  return {
    id: node.id.slice(0, 64),
    type: node.type as CanvasNodeType,
    x: node.x as number,
    y: node.y as number,
    w: Math.max(40, node.w as number),
    h: Math.max(28, node.h as number),
    z: isFiniteNumber(node.z) ? node.z : 1,
    createdAt: typeof node.createdAt === 'string' ? node.createdAt : now,
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : now,
    payload: node.payload && typeof node.payload === 'object' ? (node.payload as Record<string, unknown>) : {}
  };
}

export function normalizeWorkspace(raw: unknown): WorkspaceDoc {
  if (!raw || typeof raw !== 'object') return emptyWorkspace();
  const doc = raw as Record<string, unknown>;
  const viewport = (doc.viewport ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(doc.nodes)
    ? doc.nodes.map(normalizeNode).filter((node): node is CanvasNode => node !== null).slice(0, 500)
    : [];
  return {
    version: 1,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    viewport: {
      x: isFiniteNumber(viewport.x) ? viewport.x : 0,
      y: isFiniteNumber(viewport.y) ? viewport.y : 0,
      zoom: isFiniteNumber(viewport.zoom) ? Math.min(8, Math.max(0.05, viewport.zoom)) : 1
    },
    nextZ: isFiniteNumber(doc.nextZ) ? doc.nextZ : nodes.length + 1,
    nodes
  };
}
