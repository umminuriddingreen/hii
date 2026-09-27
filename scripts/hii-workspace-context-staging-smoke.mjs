#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTestTreeSync } from './lib/test-temp.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-context-staging-'));
const workspaceRoot = path.join(directory, 'project');
const runtimeRoot = path.join(directory, 'runtime');
const assetRoot = path.join(runtimeRoot, 'workspace', 'assets');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(assetRoot, { recursive: true });
process.env.HII_RUNTIME_DIR = runtimeRoot;

const contextModule = await import('../lib/server/hii-workspace-run-context.ts');
const stagingModule = await import('../runtime/daemon/workspace-run-staging.mjs');

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

try {
  const body = Buffer.from('founder-selected visual reference\n');
  const digest = sha256(body);
  const source = path.join(assetRoot, `${digest}.png`);
  fs.writeFileSync(source, body, { mode: 0o600 });
  const context = [{
    id: 'visual-reference',
    title: 'Founder-selected visual reference',
    type: 'image',
    source,
    expectedSha256: digest,
    owner: 'human',
    authority: 'hii-runtime',
    proofRefs: [`sha256:${digest}`]
  }];

  const preview = await contextModule.previewWorkspaceRunContext({
    runId: 'staging-proof',
    workspaceRoot,
    context
  });
  assert.equal(preview.blocked, false);
  assert.equal(preview.summary.stagedLocalAssets, 1);
  assert.equal(preview.items[0].access, 'staged-local-asset');
  assert.equal(preview.items[0].sha256, digest);
  assert.equal(
    preview.items[0].stagedRelativePath,
    path.join('.hii-run-context', 'staging-proof', `${digest}.png`)
  );
  assert.match(
    contextModule.workspaceRunExecutionGoal('Use the selected visual.', preview),
    /Read-only staged source: \.hii-run-context/
  );

  fs.writeFileSync(source, 'changed after review\n');
  assert.throws(
    () => stagingModule.stageWorkspaceRunContext({
      runtimeRoot,
      workspaceRoot,
      intentId: 'staging-proof',
      contextPreview: preview
    }),
    /changed after context approval/
  );
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.hii-run-context', 'staging-proof')), false);

  fs.writeFileSync(source, body, { mode: 0o600 });
  const refreshed = await contextModule.previewWorkspaceRunContext({
    runId: 'staging-proof',
    workspaceRoot,
    context
  });
  const staged = stagingModule.stageWorkspaceRunContext({
    runtimeRoot,
    workspaceRoot,
    intentId: 'staging-proof',
    contextPreview: refreshed
  });
  assert.equal(staged.required, true);
  assert.equal(staged.files.length, 1);
  const stagedPath = path.join(workspaceRoot, staged.files[0].relativePath);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), body.toString('utf8'));
  assert.equal(fs.statSync(stagedPath).mode & 0o222, 0, 'staged context must be non-writable');

  const markerPath = path.join(workspaceRoot, staged.directory, '.hii-staging.json');
  const marker = fs.readFileSync(markerPath, 'utf8');
  fs.writeFileSync(markerPath, `${JSON.stringify({ intentId: 'someone-else' })}\n`);
  const protectedCleanup = stagingModule.cleanupWorkspaceRunContext({
    workspaceRoot,
    intentId: 'staging-proof',
    staging: staged
  });
  assert.equal(protectedCleanup.cleanupStatus, 'skipped-unowned');
  assert.equal(fs.existsSync(stagedPath), true);

  fs.writeFileSync(markerPath, marker);
  const cleaned = stagingModule.cleanupWorkspaceRunContext({
    workspaceRoot,
    intentId: 'staging-proof',
    staging: staged
  });
  assert.equal(cleaned.cleanupStatus, 'removed');
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(sha256(fs.readFileSync(source)), digest);

  console.log('HII governed workspace context staging smoke');
  console.log('status:       ok');
  console.log('storage:      selected HII-managed asset kept content-addressed');
  console.log('approval:     run id + source SHA-256 bound to reviewed destination');
  console.log('execution:    immutable copy staged inside the approved workspace');
  console.log('stale guard:  source changes rejected immediately before execution');
  console.log('cleanup:      ownership marker required; only disposable copy removed');
} finally {
  removeTestTreeSync(directory);
}
