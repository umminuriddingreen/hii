#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-workspace-lifecycle-'));
const runtime = path.join(directory, 'runtime');
const workspaceRoot = path.join(directory, 'project');
const runner = path.join(directory, 'bounded-runner.mjs');
const daemon = path.resolve('aii/daemon/hiid.mjs');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });
const assetRoot = path.join(runtime, 'workspace', 'assets');
fs.mkdirSync(assetRoot, { recursive: true });
const assetBody = Buffer.from('lifecycle visual reference\n');
const assetSha256 = createHash('sha256').update(assetBody).digest('hex');
const assetSource = path.join(assetRoot, `${assetSha256}.png`);
fs.writeFileSync(assetSource, assetBody);
fs.writeFileSync(runner, `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`);
fs.chmodSync(runner, 0o755);

process.env.HII_RUNTIME_DIR = runtime;
process.env.HII_DB_PATH = path.join(runtime, 'hii.db');
process.env.HII_WORKSPACE_RUN_MODELS = 'qwen3.6:35b-mlx';
process.env.HII_WORKSPACE_RUNNER_BIN = runner;
process.env.HII_DISABLE_BACKGROUND_TICKS = '1';

const runs = await import('../lib/server/hii-workspace-runs.ts');
const jobs = await import('../lib/capabilities/local-store.ts');
const staging = await import('../aii/daemon/workspace-run-staging.mjs');

function latestJob(id) {
  try {
    const records = fs.readFileSync(path.join(runtime, 'capability-jobs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((job) => job.id === id);
    return records.at(-1) || null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

const daemonProcess = spawn(process.execPath, [daemon, 'run'], {
  cwd: path.resolve('.'),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  const context = [{
    id: 'lifecycle-reference',
    title: 'Lifecycle visual reference',
    type: 'image',
    source: assetSource,
    expectedSha256: assetSha256,
    proofRefs: [`sha256:${assetSha256}`]
  }];
  const contextPreview = await runs.previewWorkspaceRunContext({
    runId: 'lifecycle-cancel-demo',
    workspaceRoot,
    context
  });
  const queued = await runs.queueApprovedWorkspaceRun({
    id: 'lifecycle-cancel-demo',
    projectId: 'lifecycle-smoke',
    goal: 'Wait safely until the operator asks AII to stop.',
    workspaceRoot,
    model: 'qwen3.6:35b-mlx',
    maxSteps: 3,
    context,
    contextFingerprint: contextPreview.fingerprint,
    approved: true
  });
  assert.equal(queued.job.status, 'queued');

  const running = await waitFor(
    () => {
      const job = latestJob('lifecycle-cancel-demo');
      return job?.status === 'running' && Number(job.metadata?.pid) > 0 ? job : null;
    },
    'AII did not start the bounded runner.'
  );
  const runnerPid = Number(running.metadata.pid);
  assert.equal(alive(runnerPid), true);
  const stagedPath = path.join(workspaceRoot, contextPreview.items[0].stagedRelativePath);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), assetBody.toString('utf8'));
  assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o400);

  const cancellation = await runs.requestWorkspaceRunCancellation({ id: queued.job.id });
  assert.equal(cancellation.queued, true);
  const duplicate = await runs.requestWorkspaceRunCancellation({ id: queued.job.id });
  assert.equal(duplicate.queued, false);

  const cancelled = await waitFor(
    () => latestJob('lifecycle-cancel-demo')?.status === 'cancelled'
      ? latestJob('lifecycle-cancel-demo')
      : null,
    'AII did not record the workspace cancellation.'
  );
  assert.equal(cancelled.logs.some((entry) => /stopped|cancelled/i.test(entry)), true);
  await waitFor(() => !alive(runnerPid), 'The owned bounded runner process remained alive.');
  const cleaned = await waitFor(
    () => latestJob('lifecycle-cancel-demo')?.metadata?.contextStaging?.cleanupStatus === 'removed'
      ? latestJob('lifecycle-cancel-demo')
      : null,
    'AII did not remove the cancelled run context copy.'
  );
  assert.equal(cleaned.status, 'cancelled');
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.readFileSync(assetSource, 'utf8'), assetBody.toString('utf8'));

  const interruptedPreview = await runs.previewWorkspaceRunContext({
    runId: 'lifecycle-interrupted-demo',
    workspaceRoot,
    context
  });
  const interruptedStaging = staging.stageWorkspaceRunContext({
    runtimeRoot: runtime,
    workspaceRoot,
    intentId: 'lifecycle-interrupted-demo',
    contextPreview: interruptedPreview
  });
  const interruptedStagedPath = path.join(
    workspaceRoot,
    interruptedStaging.files[0].relativePath
  );
  assert.equal(fs.existsSync(interruptedStagedPath), true);
  const staleAt = new Date().toISOString();
  await jobs.appendCapabilityJob({
    id: 'lifecycle-interrupted-demo',
    capabilityId: 'hii.agent.workspace_run',
    inputSummary: 'Reconcile an interrupted workspace run.',
    userId: 'local',
    userEmail: null,
    status: 'running',
    budget: 'local · 3 steps',
    logs: [`[${staleAt}] simulated interrupted run`],
    ledger: [],
    proofArtifacts: [],
    createdAt: staleAt,
    updatedAt: staleAt,
    metadata: {
      projectId: 'lifecycle-smoke',
      workspaceRoot,
      goal: 'Reconcile an interrupted workspace run.',
      model: 'qwen3.6:35b-mlx',
      maxSteps: 3,
      pid: 999999,
      startedAt: staleAt,
      context,
      contextPreview: interruptedPreview,
      contextStaging: interruptedStaging
    }
  });
  const reconciled = await waitFor(
    () => latestJob('lifecycle-interrupted-demo')?.status === 'failed'
      ? latestJob('lifecycle-interrupted-demo')
      : null,
    'AII did not reconcile the interrupted workspace run.'
  );
  assert.match(reconciled.logs.at(-1), /no owned process or verified receipt/i);
  assert.equal(reconciled.metadata.contextStaging.cleanupStatus, 'removed');
  assert.equal(fs.existsSync(interruptedStagedPath), false);

  const intents = fs.readFileSync(path.join(runtime, 'daemon', 'intents.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(intents.map((intent) => intent.kind), ['workspace.run', 'workspace.cancel']);

  console.log('HII workspace lifecycle smoke');
  console.log('status:       ok');
  console.log('ownership:    AII persisted and stopped the owned runner PID');
  console.log('cancellation: append-only request -> terminal cancelled verified');
  console.log('race:         late runner callback did not overwrite cancellation');
  console.log('staging:      selected local asset copied read-only then cleaned on cancellation');
  console.log('recovery:     interrupted run reconciled and its marked context copy removed');
} finally {
  if (daemonProcess.exitCode === null) daemonProcess.kill('SIGTERM');
  await new Promise((resolve) => {
    if (daemonProcess.exitCode !== null) return resolve();
    daemonProcess.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
  fs.rmSync(directory, { recursive: true, force: true });
}
