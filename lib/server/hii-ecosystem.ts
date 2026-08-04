import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  HiiCapture,
  HiiEcosystemEvent,
  HiiEcosystemEventStatus,
  HiiEcosystemMode,
  HiiWorkflow,
  HiiWorkflowEdge,
  HiiWorkflowNode,
  HiiWorkflowNodeKind
} from '../ecosystem/types.ts';
import { withFileLock } from './atomic-write.ts';

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function ecosystemDir() {
  return path.join(runtimeRoot(), 'ecosystem');
}

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown, fallback = '') {
  return clean(value, 120).replace(/[^a-zA-Z0-9_-]/g, '') || fallback;
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJsonl(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, () => appendFile(file, `${JSON.stringify(value)}\n`, 'utf8'));
}

export async function createEcosystemCapture(input: {
  projectId?: unknown;
  url?: unknown;
  title?: unknown;
  selection?: unknown;
  excerpt?: unknown;
  source?: unknown;
}): Promise<HiiCapture> {
  const rawUrl = clean(input.url, 4000);
  if (!rawUrl) throw new Error('A browser URL is required.');
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HII Browser captures only http(s) sources.');
  const title = clean(input.title, 240) || url.hostname;
  const selection = clean(input.selection, 12_000);
  const excerpt = clean(input.excerpt, 12_000);
  if (!selection && !excerpt) throw new Error('Capture a page excerpt or an explicit selection.');
  const sourceValue = clean(input.source, 40);
  const source: HiiCapture['source'] = ['hii-browser', 'helium', 'extension', 'manual'].includes(sourceValue)
    ? sourceValue as HiiCapture['source']
    : 'hii-browser';
  const capture: HiiCapture = {
    schemaVersion: 1,
    kind: 'hii.capture',
    id: randomUUID(),
    projectId: cleanId(input.projectId, 'default'),
    url: url.toString(),
    title,
    selection,
    excerpt,
    source,
    permission: 'local-only',
    contentHash: digest({ url: url.toString(), selection, excerpt }),
    createdAt: new Date().toISOString()
  };
  await appendJsonl(path.join(ecosystemDir(), 'captures.jsonl'), capture);
  await recordEcosystemEvent({
    mode: 'browser',
    projectId: capture.projectId,
    status: 'completed',
    summary: `Captured ${capture.title}`,
    object: { kind: 'capture', id: capture.id },
    proofRefs: [`sha256:${capture.contentHash}`]
  });
  return capture;
}

export async function listEcosystemCaptures(limit = 80): Promise<HiiCapture[]> {
  const values = await readJsonl<HiiCapture>(path.join(ecosystemDir(), 'captures.jsonl'));
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(200, limit)));
}

const nodeKinds = new Set<HiiWorkflowNodeKind>(['capture', 'prompt', 'capability', 'approval', 'output']);

function normalizeNodes(value: unknown): HiiWorkflowNode[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error('A workflow needs at least two nodes.');
  const nodes = value.slice(0, 80).map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Workflow node ${index + 1} is invalid.`);
    const input = raw as Record<string, unknown>;
    const id = cleanId(input.id);
    const kind = clean(input.kind, 40) as HiiWorkflowNodeKind;
    const title = clean(input.title, 160);
    if (!id || !nodeKinds.has(kind) || !title) throw new Error(`Workflow node ${index + 1} needs an id, kind, and title.`);
    return {
      id,
      kind,
      title,
      ...(clean(input.capabilityId, 160) ? { capabilityId: clean(input.capabilityId, 160) } : {}),
      ...(input.config && typeof input.config === 'object' ? { config: input.config as Record<string, unknown> } : {})
    };
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error('Workflow node ids must be unique.');
  return nodes;
}

function normalizeEdges(value: unknown, nodeIds: Set<string>): HiiWorkflowEdge[] {
  if (!Array.isArray(value)) throw new Error('Workflow edges are required.');
  return value.slice(0, 160).map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Workflow edge ${index + 1} is invalid.`);
    const input = raw as Record<string, unknown>;
    const from = cleanId(input.from);
    const to = cleanId(input.to);
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) throw new Error(`Workflow edge ${index + 1} has an invalid endpoint.`);
    return { from, to };
  });
}

export async function saveEcosystemWorkflow(input: Record<string, unknown>): Promise<HiiWorkflow> {
  const id = cleanId(input.id, randomUUID());
  const title = clean(input.title, 200);
  if (!title) throw new Error('Give the workflow a title.');
  const nodes = normalizeNodes(input.nodes);
  const edges = normalizeEdges(input.edges, new Set(nodes.map((node) => node.id)));
  const adapter = input.adapter && typeof input.adapter === 'object' ? input.adapter as Record<string, unknown> : {};
  const prompt = adapter.prompt;
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) throw new Error('A ComfyUI API-format prompt is required.');
  const existing = (await listEcosystemWorkflows(500)).find((workflow) => workflow.id === id);
  const now = new Date().toISOString();
  const revision = (existing?.revision || 0) + 1;
  const revisionBody: Omit<HiiWorkflow, 'schemaVersion' | 'kind' | 'revisionHash' | 'createdAt' | 'updatedAt'> = {
    id,
    projectId: cleanId(input.projectId, 'default'),
    title,
    revision,
    nodes,
    edges,
    adapter: { id: 'comfyui' as const, prompt: prompt as Record<string, unknown> }
  };
  const workflow: HiiWorkflow = {
    schemaVersion: 1,
    kind: 'hii.workflow',
    ...revisionBody,
    revisionHash: digest(revisionBody),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await appendJsonl(path.join(ecosystemDir(), 'workflows.jsonl'), workflow);
  await recordEcosystemEvent({
    mode: 'create',
    projectId: workflow.projectId,
    status: 'ready',
    summary: `Saved ${workflow.title} revision ${workflow.revision}`,
    object: { kind: 'workflow', id: workflow.id },
    proofRefs: [`sha256:${workflow.revisionHash}`]
  });
  return workflow;
}

export async function listEcosystemWorkflows(limit = 80): Promise<HiiWorkflow[]> {
  const revisions = await readJsonl<HiiWorkflow>(path.join(ecosystemDir(), 'workflows.jsonl'));
  const latest = new Map<string, HiiWorkflow>();
  for (const workflow of revisions) {
    const current = latest.get(workflow.id);
    if (!current || workflow.revision > current.revision) latest.set(workflow.id, workflow);
  }
  return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, Math.min(500, limit)));
}

export async function getEcosystemWorkflow(id: unknown) {
  const clean = cleanId(id);
  return (await listEcosystemWorkflows(500)).find((workflow) => workflow.id === clean) || null;
}

export async function recordEcosystemEvent(input: {
  mode?: unknown;
  projectId?: unknown;
  status?: unknown;
  summary?: unknown;
  object?: HiiEcosystemEvent['object'];
  proofRefs?: unknown;
}): Promise<HiiEcosystemEvent> {
  const modeValue = clean(input.mode, 20);
  const statusValue = clean(input.status, 30);
  const modes: HiiEcosystemMode[] = ['notch', 'browser', 'create'];
  const statuses: HiiEcosystemEventStatus[] = ['ready', 'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'];
  if (!modes.includes(modeValue as HiiEcosystemMode)) throw new Error('Event mode must be notch, browser, or create.');
  if (!statuses.includes(statusValue as HiiEcosystemEventStatus)) throw new Error('Invalid ecosystem event status.');
  const summary = clean(input.summary, 500);
  if (!summary) throw new Error('An event summary is required.');
  const event: HiiEcosystemEvent = {
    schemaVersion: 1,
    kind: 'hii.ecosystem.event',
    id: randomUUID(),
    mode: modeValue as HiiEcosystemMode,
    projectId: cleanId(input.projectId, 'default'),
    status: statusValue as HiiEcosystemEventStatus,
    summary,
    ...(input.object ? { object: input.object } : {}),
    proofRefs: Array.isArray(input.proofRefs) ? input.proofRefs.map((ref) => clean(ref, 1000)).filter(Boolean).slice(0, 20) : [],
    createdAt: new Date().toISOString()
  };
  await appendJsonl(path.join(ecosystemDir(), 'events.jsonl'), event);
  return event;
}

export async function listEcosystemEvents(limit = 80): Promise<HiiEcosystemEvent[]> {
  const events = await readJsonl<HiiEcosystemEvent>(path.join(ecosystemDir(), 'events.jsonl'));
  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(200, limit)));
}

export async function ecosystemSummary() {
  const [captures, workflows, events] = await Promise.all([
    listEcosystemCaptures(12),
    listEcosystemWorkflows(12),
    listEcosystemEvents(24)
  ]);
  const active = events.find((event) => ['queued', 'running', 'waiting_approval'].includes(event.status)) || null;
  return {
    schemaVersion: 1,
    kind: 'hii.ecosystem.summary',
    generatedAt: new Date().toISOString(),
    modes: ['notch', 'browser', 'create'] as const,
    active,
    recent: events.slice(0, 8),
    captureCount: captures.length,
    workflowCount: workflows.length,
    latestCapture: captures[0] || null,
    latestWorkflow: workflows[0] || null
  };
}
