import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { queueApprovedWorkspaceRun, getWorkspaceRun } from '../lib/server/hii-workspace-runs.ts';
import { createWorkspace, listWorkspaces, writeWorkspace } from '../lib/server/workspace-store.ts';
import {
  buildLaunchProofWorkspace,
  launchProofGoal,
  launchProofWorkspaceId,
  launchStoryboardPath
} from '../lib/workspace/launch-proof.ts';

async function daemonReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/daemon`);
    const result = await response.json();
    return response.ok && result.alive === true;
  } catch {
    return false;
  }
}

async function waitForRun(runId, timeoutMs = 8 * 60 * 1000) {
  const started = Date.now();
  let lastStatus = '';
  while (Date.now() - started < timeoutMs) {
    const run = await getWorkspaceRun(runId);
    const status = String(run?.job.status || 'missing');
    if (status !== lastStatus) {
      console.log(`run:          ${status}`);
      lastStatus = status;
    }
    if (run && ['completed', 'failed', 'cancelled'].includes(status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('The launch proof run did not reach a terminal state within eight minutes.');
}

export async function createLaunchProofWorkspace(options = {}) {
  const workspaceId = String(options.workspaceId || launchProofWorkspaceId);
  const workspaceRoot = String(options.workspaceRoot || process.cwd());
  const baseUrl = String(options.baseUrl || process.env.HII_DEV_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
  const existing = await listWorkspaces();
  if (existing.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(`Workspace "${workspaceId}" already exists. HII will not overwrite it.`);
  }
  if (!(await daemonReady(baseUrl))) {
    throw new Error(`AII is not ready at ${baseUrl}. Start it explicitly before creating the launch proof.`);
  }

  const sourceIds = [randomUUID(), randomUUID(), randomUUID()];
  const context = [
    { id: sourceIds[0], title: 'HII workspace reference', type: 'image', source: path.join(workspaceRoot, 'public/marketing/hii-workspace-live.png') },
    { id: sourceIds[1], title: 'Launch brief', type: 'note', source: path.join(workspaceRoot, 'docs/launch/hii-x-launch-kit-opus5.md') },
    { id: sourceIds[2], title: 'Claim boundary', type: 'note', source: path.join(workspaceRoot, 'docs/marketing/2026-07-30-hii-agentic-environment-audit.md') }
  ];
  const runId = randomUUID();
  await queueApprovedWorkspaceRun({
    id: runId,
    projectId: 'hii-launch-proof',
    goal: launchProofGoal,
    workspaceRoot,
    model: 'qwen3.6:35b-mlx',
    maxSteps: 8,
    context,
    approved: true,
    requestedBy: 'hii.launch-proof'
  });
  console.log(`run id:       ${runId}`);
  const run = await waitForRun(runId);
  if (run.job.status !== 'completed' || !run.receipt || !run.path) {
    throw new Error(`The real launch proof run ended ${run.job.status}; no demo workspace was created.`);
  }
  const passingChecks = Array.isArray(run.receipt.verification)
    ? run.receipt.verification.filter((check) => check && typeof check === 'object' && check.ok === true)
    : [];
  if (!passingChecks.length) throw new Error('The real launch proof run returned no passing verification.');

  const doc = buildLaunchProofWorkspace(run, { workspaceRoot });
  await createWorkspace(workspaceId, false);
  const saved = await writeWorkspace(doc, 0, workspaceId);
  return { workspaceId, run, workspace: saved };
}

async function main() {
  const approve = process.argv.includes('--approve');
  const idArgument = process.argv.find((value) => value.startsWith('--workspace-id='));
  const workspaceId = idArgument?.slice('--workspace-id='.length) || launchProofWorkspaceId;
  if (!approve) {
    console.log('HII launch proof workspace');
    console.log('status:       preview only');
    console.log(`workspace:    ${workspaceId} (will not replace an existing workspace)`);
    console.log(`artifact:     ${launchStoryboardPath}`);
    console.log('boundary:     local HII repo only; no commit, push, publish, message, spend, or network');
    console.log('next:         npm run demo:launch-proof -- --approve');
    return;
  }

  const result = await createLaunchProofWorkspace({ workspaceId });
  console.log('HII launch proof workspace');
  console.log('status:       completed');
  console.log(`workspace:    ${result.workspaceId} · ${result.workspace.nodes.length} semantic nodes`);
  console.log(`receipt:      ${result.run.path}`);
  console.log(`artifact:     ${launchStoryboardPath}`);
  console.log('selection:    unchanged; open launch-proof from the HII workspace menu');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
