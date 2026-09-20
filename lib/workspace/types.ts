export type WorkspaceNodeType =
  | 'chat'
  | 'intent'
  | 'run'
  | 'note'
  | 'text'
  | 'canvas-text'
  | 'ink'
  | 'link'
  | 'file'
  | 'image'
  | 'media'
  | 'document'
  | 'cad'
  | 'model'
  | 'html'
  | 'font'
  | 'terminal'
  | 'browser'
  | 'explorer'
  | 'context'
  | 'board'
  | 'frame'
  | 'surface'
  | 'app'
  | 'job'
  | 'sound-field';

export type SpatialObjectKind =
  | 'agent'
  | 'actor'
  | 'device'
  | 'service'
  | 'space'
  | 'intent'
  | 'idea'
  | 'constraint'
  | 'component'
  | 'interface'
  | 'decision'
  | 'alternative'
  | 'task'
  | 'run'
  | 'job'
  | 'model'
  | 'file'
  | 'source'
  | 'asset'
  | 'artifact'
  | 'note'
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
  | 'cancelled'
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
  'chat',
  'intent',
  'run',
  'note',
  'text',
  'canvas-text',
  'ink',
  'link',
  'file',
  'image',
  'media',
  'document',
  'cad',
  'model',
  'html',
  'font',
  'terminal',
  'browser',
  'explorer',
  'context',
  'board',
  'frame',
  'surface',
  'app',
  'job',
  'sound-field'
];

/**
 * Spaces reuses WorkspaceNode rather than introducing a parallel object model.
 * Stickers are images whose payload carries `sticker: true`.
 */
export const spaceObjectNodeTypes = {
  Image: 'image',
  Text: 'canvas-text',
  Sticker: 'image',
  Drawing: 'ink'
} as const satisfies Record<'Image' | 'Text' | 'Sticker' | 'Drawing', WorkspaceNodeType>;

/** Object authority remains canonical at the Space policy layer for the MVP. */
export type WorkspaceNodePermissions = {
  inheritance: 'space-policy';
};

/**
 * A point in workspace space. The 2D canvas is the plane z = 0.
 */
export type Vec3 = { x: number; y: number; z: number };

/** Orientation as a unit quaternion. Identity is `{ x: 0, y: 0, z: 0, w: 1 }`. */
export type Quaternion = { x: number; y: number; z: number; w: number };

/**
 * The full spatial placement of an object.
 *
 * The 2D and 3D views are two projections of this one value, not two systems
 * kept in sync by hand. `position`/`rotation`/`scale` are authoritative;
 * `x`/`y`/`rotation` on the node are the 2D projection of the same placement
 * and are reconciled on every normalize, so code written against either one
 * reads the same truth.
 *
 * `size` carries the object's extent. Depth defaults to zero because a canvas
 * card is a plane, and a plane given arbitrary thickness renders as a slab
 * nobody asked for.
 */
export type WorkspaceTransform = {
  position: Vec3;
  rotation: Quaternion;
  scale: Vec3;
  size: Vec3;
};

export const IDENTITY_QUATERNION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };

/** Rotation about the view axis, which is the only rotation a 2D canvas can express. */
export function quaternionFromZDegrees(degrees: number): Quaternion {
  const half = ((Number.isFinite(degrees) ? degrees : 0) * Math.PI) / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

/**
 * Recover the 2D rotation from a quaternion.
 *
 * Any out-of-plane component is dropped rather than approximated: the 2D view
 * cannot draw it, and inventing an angle for it would make a card jump when a
 * 3D rotation is projected back down.
 */
export function zDegreesFromQuaternion(rotation: Quaternion): number {
  const angle = Math.atan2(
    2 * (rotation.w * rotation.z + rotation.x * rotation.y),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z)
  );
  const degrees = (angle * 180) / Math.PI;
  return Number.isFinite(degrees) ? degrees : 0;
}

export type WorkspaceNode = {
  id: string;
  type: WorkspaceNodeType;
  /** Stable Space identity, independent of its current host or address. */
  spaceId?: string;
  /** Object attribution such as `user:<id>` or `guest:<id>`. */
  creatorId?: string;
  /**
   * The `@name` the user assigned to this object.
   *
   * Absent means the object is still addressable by a handle derived from its
   * title; see `lib/workspace/handles.ts`. Only the authored name lives in the
   * document, because only the authored name is meant to survive a retitle.
   */
  handle?: string;
  /**
   * Authoritative spatial placement, shared by the 2D and 3D projections.
   *
   * Always present after `normalizeNode`. It is optional on the type only so
   * that documents written before the 3D migration still parse.
   */
  transform?: WorkspaceTransform;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Clockwise degrees. Legacy nodes normalize to zero. */
  rotation?: number;
  createdAt: string;
  updatedAt: string;
  /** Declares policy inheritance; it does not grant per-object authority. */
  permissions?: WorkspaceNodePermissions;
  object?: SpatialObjectMetadata;
  objectRef?: {
    authority: 'hii-knowledge' | 'knowledge-vault' | 'hii-runtime';
    id: string;
    projectId?: string;
    kind?: string;
  };
  frameId?: string;
  payload: Record<string, unknown>;
};

/** Canonical CSS transform used for both rendering and in-progress dragging. */
export function workspaceNodeTransform(node: Pick<WorkspaceNode, 'x' | 'y' | 'rotation'>) {
  const rotation = typeof node.rotation === 'number' && Number.isFinite(node.rotation) ? node.rotation : 0;
  return `translate3d(${node.x}px, ${node.y}px, 0) rotate(${rotation}deg)`;
}

/**
 * The node's placement in world space.
 *
 * Note what is *not* here: `node.z`. That field is paint order for the 2D
 * canvas — the stacking index handed out by `nextZ` — and reading it as depth
 * would scatter every card along the view axis by how recently it was touched.
 * Depth is `transform.position.z`, and it is zero until something sets it.
 */
export function workspaceNodeTransform3D(node: WorkspaceNode): WorkspaceTransform {
  if (node.transform) return node.transform;
  return {
    position: { x: node.x, y: node.y, z: 0 },
    rotation: quaternionFromZDegrees(node.rotation ?? 0),
    scale: { x: 1, y: 1, z: 1 },
    size: { x: node.w, y: node.h, z: 0 }
  };
}

/**
 * Rebuild a node's 2D projection from its authoritative transform.
 *
 * Every write path should go through this rather than setting `x`/`y` beside
 * `transform`, which is how the two representations drift apart.
 */
export function withWorkspaceTransform(node: WorkspaceNode, transform: WorkspaceTransform): WorkspaceNode {
  return {
    ...node,
    transform,
    x: transform.position.x,
    y: transform.position.y,
    w: Math.max(40, transform.size.x),
    h: Math.max(28, transform.size.y),
    rotation: zDegreesFromQuaternion(transform.rotation)
  };
}

/** Move a node in world space, keeping both projections consistent. */
export function moveWorkspaceNode(node: WorkspaceNode, position: Partial<Vec3>): WorkspaceNode {
  const current = workspaceNodeTransform3D(node);
  return withWorkspaceTransform(node, {
    ...current,
    position: {
      x: isFiniteNumber(position.x) ? position.x : current.position.x,
      y: isFiniteNumber(position.y) ? position.y : current.position.y,
      z: isFiniteNumber(position.z) ? position.z : current.position.z
    }
  });
}

export type WorkspaceViewport = { x: number; y: number; zoom: number };

/**
 * A connector the user drew.
 *
 * Distinct from the edges derived from `object.parentId` and `payload.context`,
 * which are records of how work actually flowed and must not be editable. An
 * authored link is the user's own annotation and carries no provenance claim.
 */
export type WorkspaceLink = {
  id: string;
  fromId: string;
  toId: string;
  label?: string;
  /** Arrowhead placement. Defaults to an arrow at the `to` end. */
  arrow?: 'none' | 'end' | 'both';
};

export type WorkspaceDoc = {
  version: 1;
  revision: number;
  updatedAt: string;
  viewport: WorkspaceViewport;
  nextZ: number;
  nodes: WorkspaceNode[];
  links: WorkspaceLink[];
};

export function emptyWorkspace(): WorkspaceDoc {
  return {
    version: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nextZ: 1,
    nodes: [],
    links: []
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
    'actor',
    'device',
    'service',
    'space',
    'intent',
    'idea',
    'constraint',
    'component',
    'interface',
    'decision',
    'alternative',
    'task',
    'run',
    'job',
    'model',
    'file',
    'source',
    'asset',
    'artifact',
    'note',
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
    'cancelled',
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

function normalizeHandleField(raw: unknown): string | undefined {
  const handle = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return handle || undefined;
}

function vec3(raw: unknown, fallback: Vec3): Vec3 {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    x: isFiniteNumber(value.x) ? value.x : fallback.x,
    y: isFiniteNumber(value.y) ? value.y : fallback.y,
    z: isFiniteNumber(value.z) ? value.z : fallback.z
  };
}

/**
 * Reconcile the stored transform against the 2D fields.
 *
 * A document written before the migration has no transform, so one is built
 * from `x`/`y`/`w`/`h`/`rotation` at depth zero. A document that has both is
 * trusted on the transform, because that is the authoritative half — but a
 * non-unit quaternion is renormalized rather than accepted, since an
 * unnormalized rotation silently scales everything it is applied to.
 */
function normalizeTransform(
  raw: unknown,
  plane: { x: number; y: number; w: number; h: number; rotation: number }
): WorkspaceTransform {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;

  // The plane wins on everything the plane can express.
  //
  // `x/y/w/h/rotation` are what every existing writer patches - the canvas
  // drag, the realtime move event, the replication merge - and none of them
  // know `transform` exists. If a stored transform could override them, a
  // plain 2D move would silently snap back to wherever the object last was in
  // 3D, and the move would look like it never happened. So the transform
  // carries only what the plane cannot say: depth, scale, and off-axis
  // rotation. A 3D writer patches both together (see WorkspaceScene3D).
  const storedPosition = vec3(source?.position, { x: plane.x, y: plane.y, z: 0 });
  const storedSize = vec3(source?.size, { x: plane.w, y: plane.h, z: 0 });
  const position = { x: plane.x, y: plane.y, z: storedPosition.z };
  const size = { x: plane.w, y: plane.h, z: storedSize.z };
  const scale = vec3(source?.scale, { x: 1, y: 1, z: 1 });

  const rawRotation = source?.rotation && typeof source.rotation === 'object'
    ? (source.rotation as Record<string, unknown>)
    : null;
  const stored = rawRotation
    ? {
        x: isFiniteNumber(rawRotation.x) ? rawRotation.x : 0,
        y: isFiniteNumber(rawRotation.y) ? rawRotation.y : 0,
        z: isFiniteNumber(rawRotation.z) ? rawRotation.z : 0,
        w: isFiniteNumber(rawRotation.w) ? rawRotation.w : 1
      }
    : null;
  // Off-axis tilt has no 2D equivalent, so a stored quaternion is kept as long
  // as it still agrees with `node.rotation`. Once they disagree the plane has
  // been rotated by a 2D writer, and it is the one telling the truth.
  const storedDegrees = stored ? zDegreesFromQuaternion(stored) : null;
  let rotation = stored && storedDegrees !== null && Math.abs(storedDegrees - plane.rotation) < 0.01
    ? stored
    : quaternionFromZDegrees(plane.rotation);
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  rotation = length > 0
    ? { x: rotation.x / length, y: rotation.y / length, z: rotation.z / length, w: rotation.w / length }
    : IDENTITY_QUATERNION;

  return {
    position,
    rotation,
    scale: { x: scale.x || 1, y: scale.y || 1, z: scale.z || 1 },
    size: { x: Math.max(40, size.x), y: Math.max(28, size.y), z: Math.max(0, size.z) }
  };
}

export function normalizeNode(raw: unknown): WorkspaceNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.id !== 'string' || !node.id) return null;
  if (!workspaceNodeTypes.includes(node.type as WorkspaceNodeType)) return null;
  if (![node.x, node.y, node.w, node.h].every(isFiniteNumber)) return null;
  const now = new Date().toISOString();
  const objectRef = node.objectRef && typeof node.objectRef === 'object' ? node.objectRef as Record<string, unknown> : null;
  const normalizedRef = objectRef && (objectRef.authority === 'hii-knowledge' || objectRef.authority === 'knowledge-vault' || objectRef.authority === 'hii-runtime') && typeof objectRef.id === 'string'
    ? {
        authority: objectRef.authority as 'hii-knowledge' | 'knowledge-vault' | 'hii-runtime',
        id: objectRef.id.slice(0, 160),
        projectId: sanitizeText(objectRef.projectId, 120),
        kind: sanitizeText(objectRef.kind, 80)
      }
    : undefined;
  const permissions = node.permissions && typeof node.permissions === 'object'
    && (node.permissions as Record<string, unknown>).inheritance === 'space-policy'
    ? { inheritance: 'space-policy' as const }
    : undefined;
  const plane = {
    x: node.x as number,
    y: node.y as number,
    w: Math.max(40, node.w as number),
    h: Math.max(28, node.h as number),
    rotation: isFiniteNumber(node.rotation) ? node.rotation : 0
  };
  const transform = normalizeTransform(node.transform, plane);
  // Stored only when it says something the plane cannot: depth, scale, or
  // off-axis rotation. A transform that merely restates `x/y/w/h/rotation` is
  // pure duplication - it doubles every document, and it gives a stale copy of
  // the plane somewhere to hide. `workspaceNodeTransform3D` derives it on
  // demand for the 3D view, so nothing needs the stored form to be present.
  const flat = transform.position.z === 0
    && transform.size.z === 0
    && transform.scale.x === 1
    && transform.scale.y === 1
    && transform.scale.z === 1
    && transform.rotation.x === 0
    && transform.rotation.y === 0;
  return {
    id: node.id.slice(0, 64),
    type: node.type as WorkspaceNodeType,
    spaceId: sanitizeText(node.spaceId, 160),
    creatorId: sanitizeText(node.creatorId, 160),
    handle: normalizeHandleField(node.handle),
    ...(flat ? {} : { transform }),
    x: plane.x,
    y: plane.y,
    w: plane.w,
    h: plane.h,
    z: isFiniteNumber(node.z) ? node.z : 1,
    rotation: plane.rotation,
    createdAt: typeof node.createdAt === 'string' ? node.createdAt : now,
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : now,
    permissions,
    object: normalizeSpatialObject(node.object),
    objectRef: normalizedRef,
    frameId: sanitizeText(node.frameId, 64),
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
    revision: isFiniteNumber(doc.revision) ? Math.max(0, Math.floor(doc.revision)) : 0,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    viewport: {
      x: isFiniteNumber(viewport.x) ? viewport.x : 0,
      y: isFiniteNumber(viewport.y) ? viewport.y : 0,
      zoom: isFiniteNumber(viewport.zoom) ? Math.min(8, Math.max(0.05, viewport.zoom)) : 1
    },
    nextZ: isFiniteNumber(doc.nextZ) ? doc.nextZ : nodes.length + 1,
    nodes,
    links: normalizeLinks(doc.links, nodes)
  };
}

/**
 * Keep only links whose endpoints still exist.
 *
 * A dangling connector would render to nowhere, so deleting a node implicitly
 * deletes the links touching it — enforced here rather than at every delete site.
 */
export function normalizeLinks(raw: unknown, nodes: WorkspaceNode[]): WorkspaceLink[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const links: WorkspaceLink[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const link = entry as Record<string, unknown>;
    const fromId = typeof link.fromId === 'string' ? link.fromId : '';
    const toId = typeof link.toId === 'string' ? link.toId : '';
    if (!known.has(fromId) || !known.has(toId) || fromId === toId) continue;
    const id = typeof link.id === 'string' && link.id ? link.id.slice(0, 64) : `${fromId}->${toId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    links.push({
      id,
      fromId,
      toId,
      label: sanitizeText(link.label, 120),
      arrow: link.arrow === 'none' || link.arrow === 'both' ? link.arrow : 'end'
    });
    if (links.length >= 1_000) break;
  }
  return links;
}
