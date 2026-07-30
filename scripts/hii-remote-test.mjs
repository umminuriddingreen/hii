#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_HTTPS_PORT,
  ARTIFACT_PORT,
  MODEL,
  TERMINAL_HTTPS_PORT,
  TERMINAL_PORT,
  archiveSessionForReset,
  funnelStopArgs,
  inspectPreflight,
  newSecret,
  newSessionId,
  readJson,
  remoteTestsRoot,
  routeOwnedBy,
  runCommand
} from '../server/remote-test-core.mjs';
import {
  analyzeRemoteTests,
  formatHarnessInsights
} from '../server/remote-test-insights.mjs';
import { runRemoteEvaluation } from '../server/remote-test-eval.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayFile = path.join(repository, 'server', 'remote-test-gateway.mjs');
const root = remoteTestsRoot();
const stateFile = path.join(root, 'active.json');
const tailscale = '/usr/local/bin/tailscale';
const defaultBinary = path.join(repository, 'target', 'release', 'hii');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function preflight() {
  return await inspectPreflight({
    hiiBinary: process.env.HII_REMOTE_TEST_BINARY || defaultBinary,
    tailscale,
    terminalPort: Number(process.env.HII_REMOTE_TEST_TERMINAL_PORT) || TERMINAL_PORT,
    artifactPort: Number(process.env.HII_REMOTE_TEST_ARTIFACT_PORT) || ARTIFACT_PORT
  });
}

async function status() {
  const state = await readJson(stateFile);
  if (!state) return { status: 'stopped' };
  return { ...state, processAlive: alive(state.pid), status: alive(state.pid) ? 'running' : 'stale' };
}

function requestedModel(args = process.argv.slice(3)) {
  const index = args.indexOf('--model');
  const raw = index >= 0 ? args[index + 1] : args.find((value) => !value.startsWith('-'));
  if (index >= 0 && !raw) throw new Error('--model requires a model name');
  if (!raw) return null;
  const model = raw.trim();
  if (!model || model.length > 128 || /[\u0000-\u001f]/.test(model)) {
    throw new Error('invalid model name');
  }
  return model;
}

function optionValue(name, args = process.argv.slice(3)) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function reusableSession(state, manifest) {
  const expectedDir = path.join(root, state.sessionId);
  if (
    !/^[a-zA-Z0-9-]{20,80}$/.test(state.sessionId ?? '') ||
    !/^[a-zA-Z0-9_-]{20,80}$/.test(state.sessionPath ?? '') ||
    path.resolve(state.sessionDir ?? '') !== expectedDir
  ) {
    throw new Error('active session state is not safe to reuse');
  }
  return {
    sessionId: state.sessionId,
    sessionPath: state.sessionPath,
    model: manifest?.model || MODEL
  };
}

async function launch(options = {}) {
  const reuse = options.reuse ?? null;
  const current = await status();
  if (!reuse && current.status === 'running') {
    print(current);
    return;
  }
  const report = await preflight();
  print({ preflight: report.checks });
  if (!report.ok) {
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    const recovery = [];
    if (failed.includes('tailscale-connected')) recovery.push('open -a Tailscale');
    if (failed.some((name) => name.startsWith('funnel-'))) {
      recovery.push('/usr/local/bin/tailscale funnel status');
    }
    if (failed.includes('ollama-model')) recovery.push('open -a Ollama');
    throw new Error(
      `preflight failed; no server, PTY, or Funnel route was changed${recovery.length ? `. Recovery: ${recovery.join(' ; ')}` : ''}`
    );
  }
  const id = reuse?.sessionId ?? newSessionId();
  const sessionPath = reuse?.sessionPath ?? newSecret(24);
  const model = options.model || reuse?.model || process.env.HII_REMOTE_TEST_MODEL || MODEL;
  const terminalPort = Number(process.env.HII_REMOTE_TEST_TERMINAL_PORT) || TERMINAL_PORT;
  const artifactPort = Number(process.env.HII_REMOTE_TEST_ARTIFACT_PORT) || ARTIFACT_PORT;
  const dnsName = String(report.tailscaleDnsName ?? '').replace(/\.$/, '');
  if (!dnsName) throw new Error('Tailscale did not report a DNS name');
  const config = {
    root,
    stateFile,
    sessionId: id,
    sessionPath,
    hiiBinary: report.hiiBinary,
    tailscale,
    terminalPort,
    artifactPort,
    chromePath: report.chromePath,
    artifactOrigin: `https://${dnsName}:${ARTIFACT_HTTPS_PORT}`,
    model,
    expose: true,
    disconnectGraceMs: 0
  };
  const child = fork(gatewayFile, [], {
    detached: true,
    env: {
      ...process.env,
      HII_REMOTE_TEST_CONFIG: Buffer.from(JSON.stringify(config)).toString('base64url')
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway startup timed out')), 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timer);
        resolve(message);
      } else if (message?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    });
    child.send({ type: 'start' });
  });
  if (child.connected) child.disconnect();
  child.unref();
  print({
    status: 'running',
    sessionId: id,
    pid: ready.pid,
    terminal: `https://${dnsName}${ready.basePath}/`,
    artifacts: `https://${dnsName}:${ARTIFACT_HTTPS_PORT}${ready.basePath}/`,
    model,
    reusedSession: Boolean(reuse),
    note: 'Only artifacts that pass local verification are linked in the artifact pane.'
  });
}

async function start() {
  return await launch({ model: requestedModel() });
}

async function stop(options = {}) {
  const state = await readJson(stateFile);
  if (!state) {
    if (!options.quiet) print({ status: 'stopped' });
    return null;
  }
  if (alive(state.pid)) {
    process.kill(state.pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (alive(state.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (alive(state.pid)) throw new Error('gateway did not stop within 10 seconds; routes were not changed by the stop command');
  } else {
    const result = await runCommand(tailscale, ['funnel', 'status', '--json'], { allowFailure: true });
    let funnel = {};
    try {
      funnel = JSON.parse(result.stdout || '{}');
    } catch {}
    for (const [externalPort, localPort] of [
      [TERMINAL_HTTPS_PORT, state.terminalPort],
      [ARTIFACT_HTTPS_PORT, state.artifactPort]
    ]) {
      if (routeOwnedBy(funnel, externalPort, localPort)) {
        await runCommand(tailscale, funnelStopArgs(externalPort), { allowFailure: true });
      }
    }
    await fs.rm(stateFile, { force: true });
  }
  if (!options.quiet) print({ status: 'stopped', sessionId: state.sessionId, preserved: state.sessionDir });
  return state;
}

async function restart(model = requestedModel()) {
  const state = await readJson(stateFile);
  if (!state) throw new Error('no active session to restart; use start');
  const manifest = await readJson(path.join(state.sessionDir, 'manifest.json'));
  const reuse = reusableSession(state, manifest);
  await stop({ quiet: true });
  return await launch({ reuse, model: model || reuse.model });
}

async function switchModel() {
  const model = requestedModel(process.argv.slice(3));
  if (!model) {
    const state = await readJson(stateFile);
    const manifest = state ? await readJson(path.join(state.sessionDir, 'manifest.json')) : null;
    print({ model: manifest?.model ?? null, status: state ? (alive(state.pid) ? 'running' : 'stale') : 'stopped' });
    return;
  }
  return await restart(model);
}

async function reset(model = requestedModel()) {
  const state = await readJson(stateFile);
  if (!state) throw new Error('no active session to reset; use start');
  const manifest = await readJson(path.join(state.sessionDir, 'manifest.json'));
  const reuse = reusableSession(state, manifest);
  await stop({ quiet: true });
  const archive = await archiveSessionForReset(state.sessionDir);
  print({
    status: 'resetting',
    sessionId: state.sessionId,
    preserved: archive.historyRoot,
    moved: archive.moved
  });
  return await launch({ reuse, model: model || reuse.model });
}

async function insights() {
  const report = await analyzeRemoteTests(root);
  print(process.argv.includes('--json') ? report : formatHarnessInsights(report));
}

async function evaluate() {
  const report = await runRemoteEvaluation({
    root: path.join(root, 'evals'),
    hiiBinary: process.env.HII_REMOTE_TEST_BINARY || defaultBinary,
    model: optionValue('--model') || MODEL,
    prompt: optionValue('--prompt') ||
      'Create a polished responsive interactive color dial in public/index.html. Use no external dependencies, verify it in the browser, and finish.',
    timeoutMs: Number(optionValue('--timeout-ms')) || 240_000
  });
  if (process.argv.includes('--json')) {
    print(report);
    return;
  }
  print([
    'HII LOCAL EVALUATION',
    '',
    `model:     ${report.model}`,
    `complete:  ${report.completed ? 'yes' : 'no'}`,
    `browser:   ${report.browserVerified ? 'verified' : 'failed'}`,
    `action:    ${report.timings.firstActionMs ?? 'not measured'} ms`,
    `artifact:  ${report.timings.firstVerifiedArtifactMs ?? 'not measured'} ms`,
    `done:      ${report.timings.doneMs ?? 'not measured'} ms`,
    `evidence:  ${report.evidence.report}`
  ].join('\n'));
}

async function main() {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const command = process.argv[2] ?? 'status';
  if (command === 'start') return await start();
  if (command === 'status') return print(await status());
  if (command === 'stop') return await stop();
  if (command === 'restart') return await restart();
  if (command === 'reset') return await reset();
  if (command === 'model') return await switchModel();
  if (command === 'insights') return await insights();
  if (command === 'eval') return await evaluate();
  if (command === 'preflight') {
    const report = await preflight();
    print(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === '--help' || command === 'help') {
    print('Usage: node scripts/hii-remote-test.mjs start [--model MODEL] | restart [--model MODEL] | reset [--model MODEL] | model [MODEL] | insights [--json] | eval [--prompt TEXT] [--model MODEL] [--timeout-ms MS] | status | stop | preflight');
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`hii remote test: ${error.message}\n`);
  process.exitCode = 1;
});
