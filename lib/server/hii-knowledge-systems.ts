import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureKnowledgeVault, knowledgeVaultPath } from './hii-vault.ts';

export const knowledgeObjectKinds = [
  'note', 'idea', 'source', 'asset', 'actor', 'intent', 'constraint', 'component', 'interface',
  'decision', 'alternative', 'task', 'run', 'artifact', 'proof', 'receipt'
] as const;

export const knowledgeRelationKinds = [
  'contains', 'references', 'informs', 'constrains', 'connects_to', 'flows_to', 'depends_on',
  'alternative_to', 'implements', 'produces', 'verifies', 'derived_from', 'supersedes'
] as const;

export type KnowledgeObjectKind = typeof knowledgeObjectKinds[number];
export type KnowledgeRelationKind = typeof knowledgeRelationKinds[number];
export type KnowledgeObjectStatus = 'proposed' | 'accepted' | 'rejected' | 'active' | 'blocked' | 'completed' | 'archived';

export type KnowledgeProvenance = {
  sourceObjectId?: string;
  noteId?: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  contentHash: string;
  confidence: number;
};

export type KnowledgeObject = {
  id: string;
  projectId: string;
  kind: KnowledgeObjectKind;
  title: string;
  summary: string;
  status: KnowledgeObjectStatus;
  owner: string;
  provenance: KnowledgeProvenance | null;
  proposalBatchId: string | null;
  externalRef: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeRelation = {
  id: string;
  projectId: string;
  fromId: string;
  toId: string;
  kind: KnowledgeRelationKind;
  label: string;
  status: 'proposed' | 'accepted' | 'rejected';
  proposalBatchId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeView = {
  id: string;
  projectId: string;
  kind: 'system-map' | 'graph' | 'board';
  name: string;
  layout: Array<{ objectId: string; x: number; y: number; w: number; h: number }>;
  filters: { kinds: KnowledgeObjectKind[]; statuses: KnowledgeObjectStatus[] };
  createdAt: string;
  updatedAt: string;
};

type SystemStore = {
  schemaVersion: 1;
  objects: KnowledgeObject[];
  relations: KnowledgeRelation[];
  views: KnowledgeView[];
};

function timestamp() {
  return new Date().toISOString();
}

function storePath(root = knowledgeVaultPath()) {
  return path.join(ensureKnowledgeVault(root), '.hii', 'systems.json');
}

function emptyStore(): SystemStore {
  return { schemaVersion: 1, objects: [], relations: [], views: [] };
}

function readStore(root = knowledgeVaultPath()): SystemStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(root), 'utf8')) as Partial<SystemStore>;
    return {
      schemaVersion: 1,
      objects: Array.isArray(parsed.objects) ? parsed.objects : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      views: Array.isArray(parsed.views) ? parsed.views : []
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: SystemStore, root = knowledgeVaultPath()) {
  const file = storePath(root);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function clean(value: unknown, max = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function objectKind(value: unknown): KnowledgeObjectKind {
  return knowledgeObjectKinds.includes(value as KnowledgeObjectKind) ? value as KnowledgeObjectKind : 'idea';
}

function relationKind(value: unknown): KnowledgeRelationKind {
  return knowledgeRelationKinds.includes(value as KnowledgeRelationKind) ? value as KnowledgeRelationKind : 'references';
}

function objectStatus(value: unknown): KnowledgeObjectStatus {
  const values: KnowledgeObjectStatus[] = ['proposed', 'accepted', 'rejected', 'active', 'blocked', 'completed', 'archived'];
  return values.includes(value as KnowledgeObjectStatus) ? value as KnowledgeObjectStatus : 'proposed';
}

export function createKnowledgeObject(input: {
  projectId?: unknown;
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  status?: unknown;
  owner?: unknown;
  provenance?: KnowledgeProvenance | null;
  proposalBatchId?: unknown;
  externalRef?: unknown;
}, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const now = timestamp();
  const object: KnowledgeObject = {
    id: randomUUID(),
    projectId: clean(input.projectId, 120) || 'shared',
    kind: objectKind(input.kind),
    title: clean(input.title, 240) || 'Untitled object',
    summary: clean(input.summary, 20_000),
    status: objectStatus(input.status),
    owner: clean(input.owner, 120) || 'human',
    provenance: input.provenance ?? null,
    proposalBatchId: clean(input.proposalBatchId, 120) || null,
    externalRef: clean(input.externalRef, 500) || null,
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  store.objects.push(object);
  writeStore(store, root);
  return object;
}

export function ensureNoteKnowledgeObject(note: {
  id: string;
  title: string;
  path: string;
  projectId: string;
  revision: string;
  updatedAt: string;
}, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const externalRef = `note:${note.id}`;
  const index = store.objects.findIndex((object) => object.externalRef === externalRef);
  const now = timestamp();
  const provenance: KnowledgeProvenance = {
    noteId: note.id,
    path: note.path,
    lineStart: 1,
    lineEnd: 1,
    contentHash: note.revision,
    confidence: 1
  };
  if (index >= 0) {
    const current = store.objects[index];
    if (current.title === note.title && current.projectId === note.projectId && current.provenance?.contentHash === note.revision) return current;
    store.objects[index] = {
      ...current,
      title: note.title,
      projectId: note.projectId,
      summary: `Canonical HII knowledge note: ${note.path}`,
      provenance,
      revision: current.revision + 1,
      updatedAt: now
    };
    writeStore(store, root);
    return store.objects[index];
  }
  const object: KnowledgeObject = {
    id: randomUUID(),
    projectId: note.projectId || 'shared',
    kind: 'note',
    title: note.title,
    summary: `Canonical HII knowledge note: ${note.path}`,
    status: 'accepted',
    owner: 'human',
    provenance,
    proposalBatchId: null,
    externalRef,
    revision: 1,
    createdAt: note.updatedAt || now,
    updatedAt: now
  };
  store.objects.push(object);
  writeStore(store, root);
  return object;
}

export function updateKnowledgeObject(id: string, patch: {
  title?: unknown;
  summary?: unknown;
  status?: unknown;
  owner?: unknown;
  externalRef?: unknown;
  ifRevision?: unknown;
}, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const index = store.objects.findIndex((object) => object.id === id);
  if (index < 0) throw new Error(`Knowledge object not found: ${id}`);
  const current = store.objects[index];
  if (patch.ifRevision !== undefined && Number(patch.ifRevision) !== current.revision) {
    const error = new Error('This object changed after it was opened. Refresh before saving.') as Error & { code?: string };
    error.code = 'CONFLICT';
    throw error;
  }
  const next: KnowledgeObject = {
    ...current,
    title: patch.title === undefined ? current.title : clean(patch.title, 240) || current.title,
    summary: patch.summary === undefined ? current.summary : clean(patch.summary, 20_000),
    status: patch.status === undefined ? current.status : objectStatus(patch.status),
    owner: patch.owner === undefined ? current.owner : clean(patch.owner, 120) || current.owner,
    externalRef: patch.externalRef === undefined ? current.externalRef : clean(patch.externalRef, 500) || null,
    revision: current.revision + 1,
    updatedAt: timestamp()
  };
  store.objects[index] = next;
  if (next.status === 'rejected') {
    store.relations = store.relations.map((relation) => relation.fromId === id || relation.toId === id
      ? { ...relation, status: 'rejected', updatedAt: next.updatedAt }
      : relation);
  }
  writeStore(store, root);
  return next;
}

export function createKnowledgeRelation(input: {
  projectId?: unknown;
  fromId?: unknown;
  toId?: unknown;
  kind?: unknown;
  label?: unknown;
  status?: unknown;
  proposalBatchId?: unknown;
}, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const fromId = clean(input.fromId, 120);
  const toId = clean(input.toId, 120);
  if (!store.objects.some((object) => object.id === fromId) || !store.objects.some((object) => object.id === toId)) {
    throw new Error('Relations require two existing knowledge objects.');
  }
  const now = timestamp();
  const relation: KnowledgeRelation = {
    id: randomUUID(),
    projectId: clean(input.projectId, 120) || 'shared',
    fromId,
    toId,
    kind: relationKind(input.kind),
    label: clean(input.label, 240),
    status: input.status === 'accepted' || input.status === 'rejected' ? input.status : 'proposed',
    proposalBatchId: clean(input.proposalBatchId, 120) || null,
    createdAt: now,
    updatedAt: now
  };
  const duplicate = store.relations.find((candidate) => candidate.fromId === fromId && candidate.toId === toId && candidate.kind === relation.kind);
  if (duplicate) return duplicate;
  store.relations.push(relation);
  writeStore(store, root);
  return relation;
}

export function updateKnowledgeRelation(id: string, status: unknown, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const index = store.relations.findIndex((relation) => relation.id === id);
  if (index < 0) throw new Error(`Knowledge relation not found: ${id}`);
  const nextStatus = status === 'accepted' || status === 'rejected' ? status : 'proposed';
  store.relations[index] = { ...store.relations[index], status: nextStatus, updatedAt: timestamp() };
  writeStore(store, root);
  return store.relations[index];
}

export function saveKnowledgeView(input: {
  id?: unknown;
  projectId?: unknown;
  kind?: unknown;
  name?: unknown;
  layout?: unknown;
  filters?: unknown;
}, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const id = clean(input.id, 120) || randomUUID();
  const now = timestamp();
  const current = store.views.find((view) => view.id === id);
  const layout = Array.isArray(input.layout) ? input.layout.map((item) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      objectId: clean(value.objectId, 120),
      x: Number.isFinite(Number(value.x)) ? Number(value.x) : 0,
      y: Number.isFinite(Number(value.y)) ? Number(value.y) : 0,
      w: Math.max(120, Number(value.w) || 240),
      h: Math.max(80, Number(value.h) || 140)
    };
  }).filter((item) => item.objectId).slice(0, 500) : current?.layout || [];
  const requestedKind = input.kind === 'graph' || input.kind === 'board' ? input.kind : 'system-map';
  const view: KnowledgeView = {
    id,
    projectId: clean(input.projectId, 120) || current?.projectId || 'shared',
    kind: requestedKind,
    name: clean(input.name, 240) || current?.name || 'System Map',
    layout,
    filters: current?.filters || { kinds: [], statuses: [] },
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
  const index = store.views.findIndex((candidate) => candidate.id === id);
  if (index >= 0) store.views[index] = view;
  else store.views.push(view);
  writeStore(store, root);
  return view;
}

function lineProvenance(input: { id: string; path: string; revision: string }, start: number, end: number, confidence: number): KnowledgeProvenance {
  return { noteId: input.id, path: input.path, lineStart: start, lineEnd: end, contentHash: input.revision, confidence };
}

export function proposeSystemFromNote(note: {
  id: string;
  title: string;
  path: string;
  folder: string;
  content: string;
  revision: string;
}, root = knowledgeVaultPath()) {
  const projectId = note.path.match(/^Projects\/([^/]+)/i)?.[1] || 'shared';
  const batchId = randomUUID();
  const lines = note.content.split('\n');
  const proposed: KnowledgeObject[] = [];
  const source = createKnowledgeObject({
    projectId,
    kind: 'source',
    title: note.title,
    summary: `Canonical HII knowledge source: ${note.path}`,
    status: 'proposed',
    proposalBatchId: batchId,
    externalRef: `note:${note.id}`,
    provenance: lineProvenance(note, 1, Math.max(lines.length, 1), 1)
  }, root);
  proposed.push(source);

  const firstMeaningful = lines.findIndex((line) => line.trim() && !line.trim().startsWith('#'));
  const intentLine = firstMeaningful >= 0 ? firstMeaningful : 0;
  const intent = createKnowledgeObject({
    projectId,
    kind: 'intent',
    title: `Intent · ${note.title}`,
    summary: clean(lines[intentLine] || note.title, 1000),
    status: 'proposed',
    proposalBatchId: batchId,
    provenance: lineProvenance(note, intentLine + 1, intentLine + 1, firstMeaningful >= 0 ? 0.72 : 0.5)
  }, root);
  proposed.push(intent);
  createKnowledgeRelation({ projectId, fromId: source.id, toId: intent.id, kind: 'informs', status: 'proposed', proposalBatchId: batchId }, root);

  const candidates: Array<{ kind: KnowledgeObjectKind; title: string; summary: string; line: number; confidence: number }> = [];
  lines.forEach((line, index) => {
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading && !/^proof|notes?|references?|tags?$/i.test(heading[1].trim())) {
      candidates.push({ kind: 'component', title: heading[1].trim(), summary: `Section in ${note.title}`, line: index + 1, confidence: 0.68 });
      return;
    }
    const text = line.replace(/^\s*[-*+]\s+/, '').trim();
    if (!text || text.length < 8) return;
    if (/\b(must|should|cannot|can't|never|required|constraint|boundary)\b/i.test(text)) {
      candidates.push({ kind: 'constraint', title: text.slice(0, 90), summary: text, line: index + 1, confidence: 0.78 });
    } else if (/\b(decision|decided|choose|chosen|will use|we use|approved)\b/i.test(text)) {
      candidates.push({ kind: 'decision', title: text.slice(0, 90), summary: text, line: index + 1, confidence: 0.76 });
    } else if (/\b(alternative|option|instead|versus| vs\.? )\b/i.test(text)) {
      candidates.push({ kind: 'alternative', title: text.slice(0, 90), summary: text, line: index + 1, confidence: 0.65 });
    } else if (/\b(user|human|agent|client|customer|operator|system)\b/i.test(text) && text.length < 180) {
      candidates.push({ kind: 'actor', title: text.slice(0, 90), summary: text, line: index + 1, confidence: 0.55 });
    }
  });

  for (const candidate of candidates.slice(0, 24)) {
    const object = createKnowledgeObject({
      projectId,
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      status: 'proposed',
      proposalBatchId: batchId,
      provenance: lineProvenance(note, candidate.line, candidate.line, candidate.confidence)
    }, root);
    proposed.push(object);
    createKnowledgeRelation({
      projectId,
      fromId: candidate.kind === 'constraint' ? object.id : intent.id,
      toId: candidate.kind === 'constraint' ? intent.id : object.id,
      kind: candidate.kind === 'constraint' ? 'constrains' : candidate.kind === 'alternative' ? 'alternative_to' : 'contains',
      status: 'proposed',
      proposalBatchId: batchId
    }, root);
  }
  ensureSystemMap(projectId, root);
  return { batchId, projectId, objects: proposed, snapshot: knowledgeSystemSnapshot(projectId, root) };
}

export function ensureSystemMap(projectId: string, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const existing = store.views.find((view) => view.projectId === projectId && view.kind === 'system-map');
  const objects = store.objects.filter((object) => object.projectId === projectId && object.status !== 'rejected');
  const layout = objects.map((object, index) => ({
    objectId: object.id,
    x: 40 + (index % 4) * 260,
    y: 48 + Math.floor(index / 4) * 180,
    w: 228,
    h: 132
  }));
  return saveKnowledgeView({
    id: existing?.id,
    projectId,
    kind: 'system-map',
    name: existing?.name || `${projectId} System Map`,
    layout: existing ? [...existing.layout.filter((item) => objects.some((object) => object.id === item.objectId)), ...layout.filter((item) => !existing.layout.some((saved) => saved.objectId === item.objectId))] : layout
  }, root);
}

export function knowledgeSystemSnapshot(projectId?: string, root = knowledgeVaultPath()) {
  const store = readStore(root);
  const objects = projectId ? store.objects.filter((object) => object.projectId === projectId) : store.objects;
  const ids = new Set(objects.map((object) => object.id));
  return {
    schemaVersion: 1,
    projectId: projectId || null,
    objects,
    relations: store.relations.filter((relation) => ids.has(relation.fromId) && ids.has(relation.toId)),
    views: projectId ? store.views.filter((view) => view.projectId === projectId) : store.views,
    stats: {
      objects: objects.length,
      proposed: objects.filter((object) => object.status === 'proposed').length,
      accepted: objects.filter((object) => object.status === 'accepted' || object.status === 'active' || object.status === 'completed').length
    }
  };
}

export function removeKnowledgeObjectsByExternalRefs(externalRefs: string[], root = knowledgeVaultPath()) {
  const refs = new Set(externalRefs.map((value) => clean(value, 500)).filter(Boolean));
  if (refs.size === 0) return { removedObjects: 0, removedRelations: 0, updatedViews: 0 };
  const store = readStore(root);
  const removedIds = new Set(store.objects.filter((object) => object.externalRef && refs.has(object.externalRef)).map((object) => object.id));
  if (removedIds.size === 0) return { removedObjects: 0, removedRelations: 0, updatedViews: 0 };
  const relationCount = store.relations.length;
  let updatedViews = 0;
  store.objects = store.objects.filter((object) => !removedIds.has(object.id));
  store.relations = store.relations.filter((relation) => !removedIds.has(relation.fromId) && !removedIds.has(relation.toId));
  store.views = store.views.map((view) => {
    const layout = view.layout.filter((item) => !removedIds.has(item.objectId));
    if (layout.length !== view.layout.length) updatedViews += 1;
    return layout.length === view.layout.length ? view : { ...view, layout, updatedAt: timestamp() };
  });
  writeStore(store, root);
  return {
    removedObjects: removedIds.size,
    removedRelations: relationCount - store.relations.length,
    updatedViews
  };
}

export function attachRuntimeObject(input: {
  projectId?: unknown;
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  externalRef?: unknown;
  sourceObjectId?: unknown;
}, root = knowledgeVaultPath()) {
  const object = createKnowledgeObject({ ...input, status: 'accepted', owner: 'hii' }, root);
  const sourceObjectId = clean(input.sourceObjectId, 120);
  if (sourceObjectId) {
    createKnowledgeRelation({
      projectId: object.projectId,
      fromId: sourceObjectId,
      toId: object.id,
      kind: object.kind === 'proof' || object.kind === 'receipt' ? 'verifies' : 'produces',
      status: 'accepted'
    }, root);
  }
  ensureSystemMap(object.projectId, root);
  return object;
}

export function resetKnowledgeSystemsForTests() {
  // State is file-backed and isolated through HII_VAULT_PATH in tests.
}
