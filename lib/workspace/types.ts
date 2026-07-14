export type WorkspaceNodeType =
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

export type SpatialObjectKind =
  | 'agent'
  | 'task'
  | 'model'
  | 'source'
  | 'browser'
  | 'terminal'
  | 'receipt'
  | 'proof'
  | 'memory'
  | 'scene'
  | 'capability'
  | 'event';

export type SpatialObjectStatus =
  | 'proposed'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'approved'
  | 'rejected'
  | 'archived'
  | 'ready'
  | 'partial'
  | 'planned'
  | 'unknown';

export type SpatialAuditEntry = {
  ts: string;
  actor: 'human' | 'agent' | 'hii' | 'system';
  action: string;
  note?: string;
};

export type SpatialObjectMetadata = {
  kind: SpatialObjectKind;
  owner?: string;
  status?: SpatialObjectStatus;
  source?: string;
  capabilityId?: string;
  runId?: string;
  proofRefs?: string[];
  memoryRefs?: string[];
  parentId?: string;
  audit?: SpatialAuditEntry[];
};

export const workspaceNodeTypes: WorkspaceNodeType[] = [
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

export type WorkspaceNode = {
  id: string;
  type: WorkspaceNodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  createdAt: string;
  updatedAt: string;
  object?: SpatialObjectMetadata;
  payload: Record<string, unknown>;
};

export type WorkspaceViewport = { x: number; y: number; zoom: number };

export type WorkspaceDoc = {
  version: 1;
  updatedAt: string;
  viewport: WorkspaceViewport;
  nextZ: number;
  nodes: WorkspaceNode[];
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

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\b\r]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
  return text || undefined;
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => sanitizeText(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return items.length ? items : undefined;
}

export function normalizeSpatialObject(raw: unknown): SpatialObjectMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const object = raw as Record<string, unknown>;
  const kinds: SpatialObjectKind[] = [
    'agent',
    'task',
    'model',
    'source',
    'browser',
    'terminal',
    'receipt',
    'proof',
    'memory',
    'scene',
    'capability',
    'event'
  ];
  const statuses: SpatialObjectStatus[] = [
    'proposed',
    'queued',
    'running',
    'waiting_approval',
    'blocked',
    'failed',
    'completed',
    'approved',
    'rejected',
    'archived',
    'ready',
    'partial',
    'planned',
    'unknown'
  ];
  if (!kinds.includes(object.kind as SpatialObjectKind)) return undefined;
  const audit = Array.isArray(object.audit)
    ? object.audit
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const auditEntry = entry as Record<string, unknown>;
          const actor = ['human', 'agent', 'hii', 'system'].includes(auditEntry.actor as string)
            ? (auditEntry.actor as SpatialAuditEntry['actor'])
            : 'system';
          const ts = sanitizeText(auditEntry.ts, 64);
          const action = sanitizeText(auditEntry.action, 120);
          if (!ts || !action) return null;
          const normalized: SpatialAuditEntry = {
            ts,
            actor,
            action
          };
          const note = sanitizeText(auditEntry.note, 500);
          if (note) normalized.note = note;
          return normalized;
        })
        .filter((entry): entry is SpatialAuditEntry => entry !== null)
        .slice(-20)
    : undefined;
  return {
    kind: object.kind as SpatialObjectKind,
    owner: sanitizeText(object.owner, 80),
    status: statuses.includes(object.status as SpatialObjectStatus) ? (object.status as SpatialObjectStatus) : undefined,
    source: sanitizeText(object.source, 160),
    capabilityId: sanitizeText(object.capabilityId, 160),
    runId: sanitizeText(object.runId, 160),
    proofRefs: sanitizeStringArray(object.proofRefs, 24, 240),
    memoryRefs: sanitizeStringArray(object.memoryRefs, 24, 240),
    parentId: sanitizeText(object.parentId, 160),
    audit: audit && audit.length ? audit : undefined
  };
}

export function normalizeNode(raw: unknown): WorkspaceNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.id !== 'string' || !node.id) return null;
  if (!workspaceNodeTypes.includes(node.type as WorkspaceNodeType)) return null;
  if (![node.x, node.y, node.w, node.h].every(isFiniteNumber)) return null;
  const now = new Date().toISOString();
  return {
    id: node.id.slice(0, 64),
    type: node.type as WorkspaceNodeType,
    x: node.x as number,
    y: node.y as number,
    w: Math.max(40, node.w as number),
    h: Math.max(28, node.h as number),
    z: isFiniteNumber(node.z) ? node.z : 1,
    createdAt: typeof node.createdAt === 'string' ? node.createdAt : now,
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : now,
    object: normalizeSpatialObject(node.object),
    payload: node.payload && typeof node.payload === 'object' ? (node.payload as Record<string, unknown>) : {}
  };
}

export function normalizeWorkspace(raw: unknown): WorkspaceDoc {
  if (!raw || typeof raw !== 'object') return emptyWorkspace();
  const doc = raw as Record<string, unknown>;
  const viewport = (doc.viewport ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(doc.nodes)
    ? doc.nodes.map(normalizeNode).filter((node): node is WorkspaceNode => node !== null).slice(0, 500)
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
