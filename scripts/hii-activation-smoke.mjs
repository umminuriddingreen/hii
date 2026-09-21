#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTestTreeSync } from './lib/test-temp.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-activation-'));
const projectRoot = path.join(directory, 'approved-project');
const runtimeRoot = path.join(directory, 'runtime');
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
process.env.HII_DB_PATH = path.join(directory, 'hii.db');
process.env.HII_RUNTIME_DIR = runtimeRoot;
fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Activation smoke\nLocal founder-beta orientation.\n');
fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const activationSmoke = true;\n');

function stubBinary(name, version, list = '') {
  const windows = process.platform === 'win32';
  const file = path.join(directory, `${name}${windows ? '.js' : ''}`);
  const body = windows
    ? `console.log(process.argv[2] === 'list' ? ${JSON.stringify(list)} : ${JSON.stringify(version)});\n`
    : `#!/bin/sh\nif [ "$1" = "list" ]; then printf ${JSON.stringify(`${list}\n`)}; else echo ${JSON.stringify(version)}; fi\n`;
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

process.env.HII_CODEX_BIN = stubBinary('codex', 'codex-cli smoke');
process.env.HII_CLAUDE_BIN = stubBinary('claude', 'claude smoke');
process.env.HII_CODEX_AUTH_PATH = path.join(directory, 'codex-auth.json');
process.env.HII_CLAUDE_AUTH_PATH = path.join(directory, 'claude-auth.json');
fs.writeFileSync(process.env.HII_CODEX_AUTH_PATH, '{"signedIn":true}\n');
fs.writeFileSync(process.env.HII_CLAUDE_AUTH_PATH, '{"signedIn":true}\n');
process.env.HII_OLLAMA_BIN = stubBinary('ollama', 'ollama smoke', 'NAME ID SIZE MODIFIED\nqwen-smoke:latest abc 1GB now');

const contextDock = await import('../lib/server/hii-context-dock.ts');
const activation = await import('../lib/server/hii-activation.ts');
const activationJourney = await import('../lib/server/hii-activation-journey.ts');

try {
  const agents = await activation.detectAgents();
  assert.deepEqual(agents.map((agent) => [agent.id, agent.installed, agent.authenticated]), [
    ['codex', true, true],
    ['claude', true, true],
    ['ollama', true, null]
  ]);
  assert.equal(agents[2].detail, 'qwen-smoke:latest');

  const project = contextDock.createContextProject({ name: 'Activation smoke', rootPath: projectRoot, approved: true });
  contextDock.scanContextProject(project.id);
  const state = contextDock.contextProjectState(project.id);
  const prompt = activation.buildOrientationContract({ projectState: state, task: 'Prove activation locally.', agent: 'codex' });
  assert.match(prompt, /Prove activation locally\./);
  assert.match(prompt, /Work only inside the approved project folder:/);
  assert.match(prompt, /hii skill report/);

  const codex = await activation.startActivationRun({ projectId: project.id, agent: 'codex', task: 'Prove the Codex queue.' });
  assert.equal(codex.runKind, 'codex-exec');
  const runFile = fs.readdirSync(path.join(runtimeRoot, 'daemon', 'runs')).find((file) => file.endsWith('.json'));
  const run = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'daemon', 'runs', runFile), 'utf8'));
  assert.equal(run.cwd, fs.realpathSync(projectRoot));
  assert.equal(run.activationId, codex.activationId);

  const claude = await activation.startActivationRun({ projectId: project.id, agent: 'claude', task: 'Prove the Claude intent.' });
  assert.equal(claude.runKind, 'claude-spawn');
  const intent = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'daemon', 'intents.jsonl'), 'utf8').trim());
  assert.equal(intent.preset, 'partner-onboard');
  assert.equal(intent.cwd, fs.realpathSync(projectRoot));

  const cliRoot = path.join(runtimeRoot, 'runs', 'cli');
  const receiptPath = path.join(cliRoot, 'smoke-run', 'receipt.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(path.join(cliRoot, 'latest'), 'smoke-run\n');
  fs.writeFileSync(receiptPath, JSON.stringify({ summary: 'activation smoke verified', outcome: 'completed' }));
  const fresh = new Date(new Date(codex.startedAt).getTime() + 1000);
  fs.utimesSync(receiptPath, fresh, fresh);
  const status = await activation.readActivationReceipt(codex.activationId);
  assert.equal(status.status, 'completed');
  assert.equal(status.receipt.summary, 'activation smoke verified');

  const journeyId = 'journey-activation-smoke';
  await activationJourney.recordActivationJourneyMilestone({
    journeyId,
    milestone: 'agents_detected',
    at: codex.startedAt,
    metadata: { installedAgents: 3 }
  });
  await activationJourney.recordActivationJourneyMilestone({
    journeyId,
    milestone: 'context_previewed',
    metadata: { itemCount: state.sources.length }
  });
  await activationJourney.recordActivationJourneyMilestone({
    journeyId,
    milestone: 'context_approved',
    metadata: { sourceCount: state.sources.length }
  });
  await activationJourney.recordActivationJourneyMilestone({
    journeyId,
    activationId: codex.activationId,
    milestone: 'run_started',
    metadata: { agent: 'codex', runKind: codex.runKind }
  });
  await activationJourney.recordActivationJourneyMilestone({
    journeyId,
    activationId: codex.activationId,
    milestone: 'receipt_verified'
  });
  const journey = await activationJourney.readActivationJourney(journeyId);
  assert.equal(journey.status, 'completed');
  assert.equal(journey.milestones.length, 5);
  const funnel = await activationJourney.activationFunnelSummary();
  assert.equal(funnel.receiptsVerified, 1);
  assert.equal(funnel.completionRate, 1);
  const eventsText = fs.readFileSync(path.join(runtimeRoot, 'activations', 'events.jsonl'), 'utf8');
  assert.doesNotMatch(eventsText, /approved-project|Prove the Codex queue/);

  console.log('HII activation smoke');
  console.log('status:       ok');
  console.log('detect:       Codex + Claude + Ollama offline detection verified with stubs');
  console.log('orientation:  project context + task + permission boundary + receipt wording verified');
  console.log('routing:      Codex queue cwd + Claude partner-onboard intent cwd verified');
  console.log('receipt:      fresh latest CLI receipt resolution verified');
  console.log('journey:      five local milestones + privacy-safe funnel verified');
  console.log('network:      no network used');
} finally {
  contextDock.resetContextDockDbForTests();
  removeTestTreeSync(directory);
}
