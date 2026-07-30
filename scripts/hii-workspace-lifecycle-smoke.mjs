#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  const queued = await runs.queueApprovedWorkspaceRun({
    id: 'lifecycle-cancel-demo',
    projectId: 'lifecycle-smoke',
    goal: 'Wait safely until the operator asks AII to stop.',
    workspaceRoot,
    model: 'qwen3.6:35b-mlx',
    maxSteps: 3,
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
  assert.match(cancelled.logs.at(-1), /stopped|cancelled/i);
  await waitFor(() => !alive(runnerPid), 'The owned bounded runner process remained alive.');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(latestJob('lifecycle-cancel-demo').status, 'cancelled');

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
      startedAt: staleAt
    }
  });
  const reconciled = await waitFor(
    () => latestJob('lifecycle-interrupted-demo')?.status === 'failed'
      ? latestJob('lifecycle-interrupted-demo')
      : null,
    'AII did not reconcile the interrupted workspace run.'
  );
  assert.match(reconciled.logs.at(-1), /no owned process or verified receipt/i);

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
  console.log('recovery:     interrupted running job reconciled from process + receipt truth');
} finally {
  if (daemonProcess.exitCode === null) daemonProcess.kill('SIGTERM');
  await new Promise((resolve) => {
    if (daemonProcess.exitCode !== null) return resolve();
    daemonProcess.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
  fs.rmSync(directory, { recursive: true, force: true });
}
