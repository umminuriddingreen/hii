export const ECOSYSTEM_RESOURCE_KINDS = [
  'device',
  'agent',
  'model',
  'capability',
  'job',
  'file',
  'service',
  'space',
  'artifact',
  'receipt'
] as const;

export type EcosystemResourceKind = typeof ECOSYSTEM_RESOURCE_KINDS[number];

export type EcosystemResourceStatus = 'ready' | 'running' | 'offline' | 'blocked' | 'partial' | 'unknown';

export type EcosystemResource = {
  id: string;
  kind: EcosystemResourceKind;
  name: string;
  detail?: string;
  status: EcosystemResourceStatus;
  nodeId?: string;
  updatedAt?: string;
  sourceRef: string;
  objectRef: {
    authority: 'hii-runtime';
    id: string;
    kind: EcosystemResourceKind;
  };
};

export type EcosystemOwner = {
  id: string;
  displayName: string;
  deviceName?: string;
};

export type EcosystemSession =
  | { state: 'signed-out' }
  | { state: 'passkey-pending'; emailHint?: string }
  | { state: 'recovery'; message?: string }
  | { state: 'authenticated'; owner: EcosystemOwner };

export type EcosystemSyncState = {
  connectivity: 'online' | 'offline';
  phase: 'synced' | 'syncing' | 'pending' | 'error';
  offlineWriter: boolean;
  pendingOperations: number;
  onlineNodes: number;
  totalNodes: number;
  lastSyncedAt?: string;
};

export type ResourceProjectionSeed = {
  type: 'ecosystem-resource';
  w: number;
  h: number;
  objectRef: EcosystemResource['objectRef'];
  object: {
    kind: EcosystemResourceKind;
    owner: 'hii';
    status: EcosystemResourceStatus;
    source: string;
  };
  payload: {
    title: string;
    detail: string;
    resourceId: string;
    resourceKind: EcosystemResourceKind;
    status: EcosystemResourceStatus;
    nodeId?: string;
    updatedAt?: string;
  };
};

export type ProjectionIntent = {
  source: 'add-button' | 'drag';
  clientX?: number;
  clientY?: number;
};

export const HII_PROJECTION_MIME = 'application/x-hii-resource-projection';

const PROJECTION_SIZE: Record<EcosystemResourceKind, [number, number]> = {
  device: [340, 220],
  agent: [360, 240],
  model: [340, 220],
  capability: [360, 200],
  job: [420, 260],
  file: [380, 280],
  service: [360, 220],
  space: [440, 300],
  artifact: [420, 300],
  receipt: [380, 240]
};

export function buildResourceProjection(resource: EcosystemResource): ResourceProjectionSeed {
  const [w, h] = PROJECTION_SIZE[resource.kind];
  return {
    type: 'ecosystem-resource',
    w,
    h,
    objectRef: { ...resource.objectRef },
    object: {
      kind: resource.kind,
      owner: 'hii',
      status: resource.status,
      source: `hii://${resource.kind}/${encodeURIComponent(resource.id)}`
    },
    payload: {
      title: resource.name,
      detail: resource.detail || '',
      resourceId: resource.id,
      resourceKind: resource.kind,
      status: resource.status,
      ...(resource.nodeId ? { nodeId: resource.nodeId } : {}),
      ...(resource.updatedAt ? { updatedAt: resource.updatedAt } : {})
    }
  };
}

export function filterEcosystemResources(
  resources: readonly EcosystemResource[],
  query: string,
  kind: EcosystemResourceKind | 'all' = 'all'
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return resources.filter((resource) => {
    if (kind !== 'all' && resource.kind !== kind) return false;
    const searchable = [resource.name, resource.detail, resource.kind, resource.status, resource.nodeId]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

export function ecosystemAccessState(session: EcosystemSession) {
  if (session.state === 'authenticated') return { canViewEcosystem: true, label: session.owner.displayName };
  if (session.state === 'passkey-pending') return { canViewEcosystem: false, label: 'Waiting for passkey' };
  if (session.state === 'recovery') return { canViewEcosystem: false, label: 'Recover HII' };
  return { canViewEcosystem: false, label: 'Sign in to HII' };
}

export function ecosystemSyncPresentation(sync: EcosystemSyncState) {
  if (sync.connectivity === 'offline') {
    return {
      tone: sync.offlineWriter ? 'offline-ready' : 'offline-readonly',
      label: sync.offlineWriter ? `Offline · ${sync.pendingOperations} local` : 'Offline · view only',
      detail: sync.offlineWriter
        ? 'Changes stay on this device until HII reconnects.'
        : 'Install and enroll this device to make changes offline.'
    } as const;
  }
  if (sync.phase === 'error') return { tone: 'error', label: 'Sync needs attention', detail: 'Local work is preserved.' } as const;
  if (sync.phase === 'syncing' || sync.pendingOperations > 0) {
    return { tone: 'syncing', label: `Syncing · ${sync.pendingOperations} pending`, detail: 'Signed changes are being reconciled.' } as const;
  }
  return { tone: 'synced', label: 'All changes local + synced', detail: sync.lastSyncedAt || 'Up to date' } as const;
}

export const HII_ECOSYSTEM_PWA = {
  manifest: '/manifest.webmanifest',
  display: 'standalone',
  startUrl: '/',
  offlineWriterRequiresEnrollment: true
} as const;
