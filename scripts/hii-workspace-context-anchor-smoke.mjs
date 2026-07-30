#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-context-anchor-'));
const workspaceRoot = path.join(directory, 'project');
const runtimeRoot = path.join(directory, 'runtime');
const assetRoot = path.join(runtimeRoot, 'workspace', 'assets');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(assetRoot, { recursive: true });
process.env.HII_RUNTIME_DIR = runtimeRoot;

const contextModule = await import('../lib/server/hii-workspace-run-context.ts');
const stagingModule = await import('../aii/daemon/workspace-run-staging.mjs');

function addAsset(name, anchor) {
  const body = Buffer.from(`HII human focus proof: ${name}\n`);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const extension = path.extname(name);
  const source = path.join(assetRoot, `${sha256}${extension}`);
  fs.writeFileSync(source, body, { mode: 0o600 });
  return {
    id: name,
    title: name,
    type: extension.slice(1),
    source,
    expectedSha256: sha256,
    owner: 'human',
    authority: 'hii-runtime',
    proofRefs: [`sha256:${sha256}`],
    anchor
  };
}

try {
  const context = [
    addAsset('brief.pdf', { kind: 'document-range', pageStart: 2, pageEnd: 4 }),
    addAsset('reference.png', { kind: 'image-region', x: 0.1, y: 0.2, width: 0.45, height: 0.3, label: 'hero composition' }),
    addAsset('launch.fig', { kind: 'design-selection', frame: 'Desktop / Hero', layers: ['Headline', 'CTA'] }),
    addAsset('plan.dxf', { kind: 'drawing-view', bounds: { minX: 10, minY: 20, maxX: 80, maxY: 90 }, layers: ['Walls', 'Doors'] }),
    addAsset('demo.mp4', { kind: 'media-range', startSeconds: 3.5, endSeconds: 11.25 }),
    addAsset('prototype.glb', { kind: 'model-view', camera: [4, 3, 5], target: [0, 0.5, 0] })
  ];

  const preview = await contextModule.previewWorkspaceRunContext({
    runId: 'anchor-proof',
    workspaceRoot,
    context
  });
  assert.equal(preview.blocked, false);
  assert.equal(preview.summary.stagedLocalAssets, context.length);
  assert.equal(preview.items.every((item) => item.anchor), true);
  assert.equal(preview.items[0].anchor.pageStart, 2);

  const changedFocus = await contextModule.previewWorkspaceRunContext({
    runId: 'anchor-proof',
    workspaceRoot,
    context: [
      { ...context[0], anchor: { kind: 'document-range', pageStart: 5, pageEnd: 5 } },
      ...context.slice(1)
    ]
  });
  assert.notEqual(changedFocus.fingerprint, preview.fingerprint);

  const goal = contextModule.workspaceRunExecutionGoal('Create the reviewed launch demo.', preview);
  assert.match(goal, /Human-reviewed PDF focus: pages 2–4/);
  assert.match(goal, /Human-reviewed image focus: normalized crop/);
  assert.match(goal, /Human-reviewed design focus: frame "Desktop \/ Hero"/);
  assert.match(goal, /Human-reviewed drawing focus: bounds/);
  assert.match(goal, /Human-reviewed media focus: 0:03.5–0:11.3/);
  assert.match(goal, /Human-reviewed 3D view: camera \[4, 3, 5\]/);

  const staged = stagingModule.stageWorkspaceRunContext({
    runtimeRoot,
    workspaceRoot,
    intentId: 'anchor-proof',
    contextPreview: preview
  });
  assert.equal(staged.files.length, context.length);
  assert.equal(staged.files.every((file) => file.anchor), true);
  for (const file of staged.files) {
    const stagedPath = path.join(workspaceRoot, file.relativePath);
    assert.equal(fs.existsSync(stagedPath), true);
    assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o400);
  }

  const cleaned = stagingModule.cleanupWorkspaceRunContext({
    workspaceRoot,
    intentId: 'anchor-proof',
    staging: staged
  });
  assert.equal(cleaned.cleanupStatus, 'removed');
  assert.equal(context.every((item) => fs.existsSync(item.source)), true);

  console.log('HII governed sub-asset context anchor smoke');
  console.log('status:       ok');
  console.log(`asset types:  ${context.length}`);
  console.log('approval:     exact human focus changes the run fingerprint');
  console.log('execution:    focus instructions and read-only staged copies agree');
  console.log('cleanup:      disposable copies removed; HII source assets preserved');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
