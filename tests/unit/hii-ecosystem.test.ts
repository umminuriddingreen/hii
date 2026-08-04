// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}), { virtual: true });

let runtimeDir = '';

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-ecosystem-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function ecosystem() {
  return import('../../lib/server/hii-ecosystem');
}

const workflowInput = {
  id: 'image-study',
  projectId: 'research',
  title: 'Image study',
  nodes: [
    { id: 'source', kind: 'capture', title: 'Reference' },
    { id: 'comfy', kind: 'capability', title: 'ComfyUI', capabilityId: 'thirdparty.comfyui' },
    { id: 'approval', kind: 'approval', title: 'Human approval' },
    { id: 'output', kind: 'output', title: 'Artifact' }
  ],
  edges: [
    { from: 'source', to: 'comfy' },
    { from: 'comfy', to: 'approval' },
    { from: 'approval', to: 'output' }
  ],
  adapter: { id: 'comfyui', prompt: { '1': { class_type: 'SaveImage', inputs: {} } } }
};

describe('HII Notch Browser Create ecosystem', () => {
  it('stores browser captures locally with source hashes and an ecosystem event', async () => {
    const { createEcosystemCapture, ecosystemSummary, listEcosystemCaptures } = await ecosystem();
    const capture = await createEcosystemCapture({
      projectId: 'research',
      url: 'https://example.com/reference',
      title: 'Example reference',
      selection: 'A source-linked selection',
      source: 'hii-browser'
    });

    expect(capture).toMatchObject({
      kind: 'hii.capture',
      projectId: 'research',
      permission: 'local-only',
      source: 'hii-browser'
    });
    expect(capture.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await listEcosystemCaptures()).toHaveLength(1);
    expect(await ecosystemSummary()).toMatchObject({
      modes: ['notch', 'browser', 'create'],
      captureCount: 1,
      recent: [expect.objectContaining({ mode: 'browser', status: 'completed' })]
    });
    expect(await readFile(path.join(runtimeDir, 'ecosystem', 'captures.jsonl'), 'utf8')).toContain(capture.id);
  });

  it('versions Create workflows and preserves the exact ComfyUI prompt revision', async () => {
    const { listEcosystemWorkflows, saveEcosystemWorkflow } = await ecosystem();
    const first = await saveEcosystemWorkflow(workflowInput);
    const second = await saveEcosystemWorkflow({
      ...workflowInput,
      adapter: { id: 'comfyui', prompt: { '1': { class_type: 'PreviewImage', inputs: {} } } }
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.revisionHash).not.toBe(first.revisionHash);
    expect(await listEcosystemWorkflows()).toEqual([expect.objectContaining({ revision: 2 })]);
    const revisions = (await readFile(path.join(runtimeDir, 'ecosystem', 'workflows.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(revisions.map((entry) => entry.revision)).toEqual([1, 2]);
  });

  it('rejects invalid graph edges and non-http browser sources', async () => {
    const { createEcosystemCapture, saveEcosystemWorkflow } = await ecosystem();
    await expect(createEcosystemCapture({ url: 'file:///private/secret', excerpt: 'nope' })).rejects.toThrow(/http/);
    await expect(saveEcosystemWorkflow({
      ...workflowInput,
      edges: [{ from: 'source', to: 'missing' }]
    })).rejects.toThrow(/invalid endpoint/);
  });
});
