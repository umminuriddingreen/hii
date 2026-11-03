import { createHash } from 'node:crypto';
import type {
  MutationActor,
  OperationalObject,
  OperationalRelation,
  RelationType
} from '../operational-graph/types.ts';
import { applyGraphMutation } from './operational-graph-mutations.ts';
import { readOperationalSpace } from './operational-object-store.ts';

export type MemoryKind =
  | 'note'
  | 'decision'
  | 'task'
  | 'receipt'
  | 'skill'
  | 'source'
  | 'question'
  | 'person'
  | 'project';

export type MemoryBlock =
  | { type: 'text'; text: string }
  | { type: 'check'; text: string; checked: boolean }
  | { type: 'code'; language?: string; text: string }
  | { type: 'embed'; objectId: string; caption?: string };

export type SourceRef = {
  system: string;
  path?: string;
  url?: string;
  range?: string;
  hash?: string;
  receiptId?: string;
};

export type MemoryObjectInput = {
  id?: string;
  kind: MemoryKind;
  title: string;
  blocks?: MemoryBlock[];
  tags?: string[];
  status?: string;
  sourceRefs?: SourceRef[];
  facets?: Record<string, unknown>;
  ownerActorId?: string;
  idempotencyKey?: string;
};

export type MemoryPatchInput = {
  id: string;
  baseVersion: number;
  title?: string;
  blocks?: MemoryBlock[];
  tags?: string[];
  status?: string;
  sourceRefs?: SourceRef[];
  facets?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type MemoryRelationInput = {
  id?: string;
  type: Exclude<RelationType, 'AUTHORED_LINK' | 'VERIFIED_BY'>;
  fromObjectId: string;
  toObjectId: string;
  label?: string;
  idempotencyKey?: string;
};

export type MemoryWorkspaceSnapshot = {
  spaceId: string;
  objects: OperationalObject[];
  relations: OperationalRelation[];
};

const memoryKinds = new Set<MemoryKind>([
  'note',
  'decision',
  'task',
  'receipt',
  'skill',
  'source',
  'question',
  'person',
  'project'
]);

function cleanText(value: unknown, field: string, max = 500) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  if (text.length > max) throw new TypeError(`${field} is longer than ${max} characters`);
  return text;
}

function cleanKind(value: unknown): MemoryKind {
  const kind = cleanText(value, 'kind', 80) as MemoryKind;
  if (!memoryKinds.has(kind)) throw new TypeError(`unknown memory kind "${kind}"`);
  return kind;
}

function cleanTags(tags: unknown) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].sort();
}

function cleanBlocks(blocks: unknown): MemoryBlock[] {
  if (!Array.isArray(blocks)) return [];
  const cleaned: MemoryBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    const type = String(item.type ?? '').trim();
    if (type === 'text') {
      cleaned.push({ type, text: cleanText(item.text, 'block.text', 20_000) });
      continue;
    }
    if (type === 'check') {
      cleaned.push({ type, text: cleanText(item.text, 'block.text', 2_000), checked: item.checked === true });
      continue;
    }
    if (type === 'code') {
      cleaned.push({
        type,
        ...(item.language ? { language: String(item.language).trim().slice(0, 80) } : {}),
        text: cleanText(item.text, 'block.text', 100_000)
      });
      continue;
    }
    if (type === 'embed') {
      cleaned.push({
        type,
        objectId: cleanText(item.objectId, 'block.objectId', 300),
        ...(item.caption ? { caption: String(item.caption).trim().slice(0, 500) } : {})
      });
    }
  }
  return cleaned;
}

function cleanSourceRefs(refs: unknown): SourceRef[] {
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref) => {
    if (!ref || typeof ref !== 'object') return [];
    const item = ref as Record<string, unknown>;
    const system = String(item.system ?? '').trim();
    if (!system) return [];
    return [
      {
        system,
        ...(item.path ? { path: String(item.path) } : {}),
        ...(item.url ? { url: String(item.url) } : {}),
        ...(item.range ? { range: String(item.range) } : {}),
        ...(item.hash ? { hash: String(item.hash) } : {}),
        ...(item.receiptId ? { receiptId: String(item.receiptId) } : {})
      }
    ];
  });
}

function hashId(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function memoryObjectId(spaceId: string, kind: MemoryKind, title: string) {
  return `memory:${spaceId}:${kind}:${hashId([spaceId, kind, title])}`;
}

export function memoryRelationId(spaceId: string, type: RelationType, fromObjectId: string, toObjectId: string) {
  return `memory:${spaceId}:relation:${type.toLowerCase()}:${hashId([spaceId, type, fromObjectId, toObjectId])}`;
}

function memoryProperties(input: MemoryObjectInput | MemoryPatchInput) {
  const properties: Record<string, unknown> = {};
  if ('kind' in input) properties.kind = cleanKind(input.kind);
  if (input.title !== undefined) properties.title = cleanText(input.title, 'title', 500);
  if (input.blocks !== undefined) properties.blocks = cleanBlocks(input.blocks);
  if (input.tags !== undefined) properties.tags = cleanTags(input.tags);
  if (input.status !== undefined) properties.status = String(input.status).trim().slice(0, 120);
  if (input.sourceRefs !== undefined) properties.sourceRefs = cleanSourceRefs(input.sourceRefs);
  if (input.facets !== undefined && input.facets && typeof input.facets === 'object' && !Array.isArray(input.facets)) {
    properties.facets = input.facets;
  }
  return properties;
}

export function createMemoryObject(spaceId: string, actor: MutationActor, input: MemoryObjectInput) {
  const kind = cleanKind(input.kind);
  const title = cleanText(input.title, 'title', 500);
  const id = input.id ?? memoryObjectId(spaceId, kind, title);
  return applyGraphMutation({
    spaceId,
    type: 'CREATE_OBJECT',
    actor,
    idempotencyKey: input.idempotencyKey ?? `create:${id}`,
    payload: {
      id,
      type: `memory.${kind}`,
      ownerActorId: input.ownerActorId ?? actor.actorId,
      provenanceClass: actor.proof?.completed ? 'verified' : 'authored',
      properties: memoryProperties({ ...input, kind, title }),
      provenance: { layer: 'hii-memory-workspace' }
    }
  });
}

export function patchMemoryObject(spaceId: string, actor: MutationActor, input: MemoryPatchInput) {
  return applyGraphMutation({
    spaceId,
    type: 'PATCH_OBJECT',
    actor,
    baseVersion: input.baseVersion,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: {
      id: cleanText(input.id, 'id', 300),
      properties: memoryProperties(input),
      provenanceClass: actor.proof?.completed ? 'verified' : undefined
    }
  });
}

export function relateMemoryObjects(spaceId: string, actor: MutationActor, input: MemoryRelationInput) {
  const type = cleanText(input.type, 'type', 80) as MemoryRelationInput['type'];
  const fromObjectId = cleanText(input.fromObjectId, 'fromObjectId', 300);
  const toObjectId = cleanText(input.toObjectId, 'toObjectId', 300);
  const id = input.id ?? memoryRelationId(spaceId, type, fromObjectId, toObjectId);
  return applyGraphMutation({
    spaceId,
    type: 'CREATE_RELATION',
    actor,
    idempotencyKey: input.idempotencyKey ?? `relate:${id}`,
    payload: {
      id,
      type,
      fromObjectId,
      toObjectId,
      properties: { ...(input.label ? { label: input.label.trim().slice(0, 500) } : {}) },
      provenance: { layer: 'hii-memory-workspace' }
    }
  });
}

export function readMemoryWorkspace(spaceId: string): MemoryWorkspaceSnapshot {
  const snapshot = readOperationalSpace(spaceId);
  const memoryIds = new Set(
    snapshot.objects
      .filter((object) => object.deletedAt === null && object.type.startsWith('memory.'))
      .map((object) => object.id)
  );
  return {
    spaceId,
    objects: snapshot.objects.filter((object) => memoryIds.has(object.id)),
    relations: snapshot.relations.filter(
      (relation) =>
        relation.deletedAt === null &&
        memoryIds.has(relation.fromObjectId) &&
        memoryIds.has(relation.toObjectId)
    )
  };
}
