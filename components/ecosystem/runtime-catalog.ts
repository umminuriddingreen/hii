'use client';

import {
  ECOSYSTEM_RESOURCE_KINDS,
  type EcosystemResource,
  type EcosystemResourceKind,
  type EcosystemResourceStatus
} from '@/lib/ecosystem/contracts';

const STATUSES = new Set<EcosystemResourceStatus>(['ready', 'running', 'offline', 'blocked', 'partial', 'unknown']);
const KINDS = new Set<EcosystemResourceKind>(ECOSYSTEM_RESOURCE_KINDS);
const MAX_RESOURCES = 128;
const MAX_TEXT = 400;

export type RuntimeCatalog = {
  schemaVersion: 1;
  kind: 'hii.ecosystem.catalog';
  authority: 'hii-runtime';
  resources: EcosystemResource[];
};

type CatalogEnvironment = {
  isTauri: boolean;
  invoke?: (command: 'ecosystem_catalog') => Promise<unknown>;
};

function text(value: unknown, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function id(value: unknown) {
  const normalized = text(value, 120);
  return /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : '';
}

function normalizeResource(value: unknown): EcosystemResource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const resourceId = id(input.id);
  const kind = text(input.kind, 24) as EcosystemResourceKind;
  const name = text(input.name, 240);
  const status = text(input.status, 24) as EcosystemResourceStatus;
  const sourceRef = text(input.sourceRef, 600);
  const objectRef = input.objectRef;
  if (!resourceId || !name || !KINDS.has(kind) || !STATUSES.has(status)) return null;
  if (!sourceRef.startsWith('hii-runtime://')) return null;
  if (!objectRef || typeof objectRef !== 'object' || Array.isArray(objectRef)) return null;
  const reference = objectRef as Record<string, unknown>;
  if (reference.authority !== 'hii-runtime' || reference.id !== resourceId || reference.kind !== kind) return null;
  const updatedAt = text(input.updatedAt, 40);
  const nodeId = id(input.nodeId);
  const detail = text(input.detail);
  return {
    id: resourceId,
    kind,
    name,
    status,
    sourceRef,
    objectRef: { authority: 'hii-runtime', id: resourceId, kind },
    ...(detail ? { detail } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

export function normalizeRuntimeCatalog(value: unknown): RuntimeCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HII returned an invalid ecosystem catalog.');
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || input.kind !== 'hii.ecosystem.catalog' || input.authority !== 'hii-runtime') {
    throw new Error('HII returned an unsupported ecosystem catalog.');
  }
  if (!Array.isArray(input.resources) || input.resources.length > MAX_RESOURCES) {
    throw new Error('HII returned an oversized ecosystem catalog.');
  }
  const resources = input.resources.map(normalizeResource).filter((resource): resource is EcosystemResource => Boolean(resource));
  resources.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return { schemaVersion: 1, kind: 'hii.ecosystem.catalog', authority: 'hii-runtime', resources };
}

export async function loadRuntimeCatalog(environment?: CatalogEnvironment): Promise<RuntimeCatalog> {
  const isTauri = environment?.isTauri ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  if (!isTauri) return { schemaVersion: 1, kind: 'hii.ecosystem.catalog', authority: 'hii-runtime', resources: [] };
  const invoke = environment?.invoke || (await import('@tauri-apps/api/core')).invoke;
  return normalizeRuntimeCatalog(await invoke('ecosystem_catalog'));
}
