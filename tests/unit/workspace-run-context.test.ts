import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  previewWorkspaceRunContext,
  workspaceRunExecutionGoal
} from '../../lib/server/hii-workspace-run-context';

const temporaryRoots: string[] = [];

function fixtureRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-context-preview-'));
  const workspaceRoot = path.join(directory, 'project');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  temporaryRoots.push(directory);
  return { directory, workspaceRoot };
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HII execution context manifest', () => {
  it('content-hashes readable workspace files and rejects a changed approval fingerprint', async () => {
    const { workspaceRoot } = fixtureRoot();
    const source = path.join(workspaceRoot, 'brief.md');
    fs.writeFileSync(source, '# First brief\n');
    const context = [{ id: 'brief', title: 'Brief', type: 'file', source: 'brief.md' }];

    const before = await previewWorkspaceRunContext({ workspaceRoot, context });
    fs.writeFileSync(source, '# Changed brief\n');
    const after = await previewWorkspaceRunContext({ workspaceRoot, context });

    expect(before.items[0]).toMatchObject({
      access: 'workspace-file',
      relativePath: 'brief.md',
      provenance: 'content-hashed file inside approved workspace root'
    });
    expect(before.items[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('snapshots human-authored context and names proof lineage in the execution goal', async () => {
    const { workspaceRoot } = fixtureRoot();
    const preview = await previewWorkspaceRunContext({
      workspaceRoot,
      context: [{
        id: 'note',
        title: 'Founder note',
        type: 'note',
        excerpt: 'Keep HII calm, spatial, and inspectable.',
        authority: 'hii-knowledge',
        proofRefs: ['receipt-1']
      }]
    });
    const goal = workspaceRunExecutionGoal('Prepare one artifact.', preview);

    expect(preview.items[0]).toMatchObject({
      access: 'inline-snapshot',
      provenance: 'selected hii-knowledge object snapshot'
    });
    expect(preview.items[0].relativePath).toBeUndefined();
    expect(goal).toContain('Approved snapshot: Keep HII calm, spatial, and inspectable.');
    expect(goal).toContain('Proof references: receipt-1');
    expect(goal).toContain(preview.fingerprint);
  });

  it('blocks inaccessible local sources and discloses remote read requirements', async () => {
    const { directory, workspaceRoot } = fixtureRoot();
    const outside = path.join(directory, 'outside.txt');
    fs.writeFileSync(outside, 'outside\n');

    const blocked = await previewWorkspaceRunContext({
      workspaceRoot,
      context: [{ id: 'outside', title: 'Outside', type: 'file', source: outside }]
    });
    const remote = await previewWorkspaceRunContext({
      workspaceRoot,
      context: [{
        id: 'remote',
        title: 'Remote source',
        type: 'link',
        source: 'https://example.com/source'
      }]
    });

    expect(blocked.blocked).toBe(true);
    expect(blocked.items[0].blockedReason).toContain('outside the approved workspace root');
    expect(remote.network).toMatchObject({ required: true });
    expect(remote.network.scope).toContain('outbound read-only web retrieval');
  });
});
