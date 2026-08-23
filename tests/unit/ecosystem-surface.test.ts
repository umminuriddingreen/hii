import { describe, expect, it } from 'vitest';
import {
  HII_ECOSYSTEM_PWA,
  buildResourceProjection,
  ecosystemAccessState,
  ecosystemSyncPresentation,
  filterEcosystemResources,
  type EcosystemResource
} from '@/lib/ecosystem/contracts';

const resources: EcosystemResource[] = [
  {
    id: 'mac-studio',
    kind: 'device',
    name: 'Mac Studio',
    detail: 'MLX · Xcode',
    status: 'ready',
    nodeId: 'node_mac',
    objectRef: { authority: 'hii-runtime', id: 'mac-studio', kind: 'device' }
  },
  {
    id: 'render-42',
    kind: 'job',
    name: 'Gallery render',
    detail: 'Windows RTX',
    status: 'running',
    nodeId: 'node_pc',
    objectRef: { authority: 'hii-runtime', id: 'render-42', kind: 'job' }
  },
  {
    id: '14th-street',
    kind: 'space',
    name: '14th Street',
    status: 'offline',
    objectRef: { authority: 'hii-runtime', id: '14th-street', kind: 'space' }
  }
];

describe('HII ecosystem surface contracts', () => {
  it('filters the object library across labels, details, node identity, and kind', () => {
    expect(filterEcosystemResources(resources, 'mlx')).toEqual([resources[0]]);
    expect(filterEcosystemResources(resources, 'windows running', 'job')).toEqual([resources[1]]);
    expect(filterEcosystemResources(resources, '', 'space')).toEqual([resources[2]]);
  });

  it('creates a reference projection instead of duplicating the canonical resource', () => {
    expect(buildResourceProjection(resources[0])).toMatchObject({
      type: 'ecosystem-resource',
      w: 340,
      h: 220,
      objectRef: { authority: 'hii-runtime', id: 'mac-studio', kind: 'device' },
      object: { owner: 'hii', source: 'hii://device/mac-studio' },
      payload: { title: 'Mac Studio', resourceId: 'mac-studio', nodeId: 'node_mac' }
    });
    expect(buildResourceProjection(resources[0])).not.toHaveProperty('payload.capabilities');
  });

  it('keeps the ecosystem inaccessible until an authenticated owner is injected', () => {
    expect(ecosystemAccessState({ state: 'signed-out' })).toEqual({ canViewEcosystem: false, label: 'Sign in to HII' });
    expect(ecosystemAccessState({ state: 'passkey-pending' }).canViewEcosystem).toBe(false);
    expect(ecosystemAccessState({ state: 'recovery' }).canViewEcosystem).toBe(false);
    expect(ecosystemAccessState({ state: 'authenticated', owner: { id: 'owner', displayName: 'Ummi' } })).toEqual({ canViewEcosystem: true, label: 'Ummi' });
  });

  it('distinguishes an enrolled offline writer from an offline read-only browser', () => {
    expect(ecosystemSyncPresentation({ connectivity: 'offline', phase: 'pending', offlineWriter: true, pendingOperations: 3, onlineNodes: 0, totalNodes: 2 })).toMatchObject({
      tone: 'offline-ready', label: 'Offline · 3 local'
    });
    expect(ecosystemSyncPresentation({ connectivity: 'offline', phase: 'synced', offlineWriter: false, pendingOperations: 0, onlineNodes: 0, totalNodes: 2 })).toMatchObject({
      tone: 'offline-readonly', label: 'Offline · view only'
    });
  });

  it('declares an installable standalone PWA contract without granting offline authority', () => {
    expect(HII_ECOSYSTEM_PWA).toEqual({
      manifest: '/manifest.webmanifest',
      display: 'standalone',
      startUrl: '/',
      offlineWriterRequiresEnrollment: true
    });
  });
});
