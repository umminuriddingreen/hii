#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_HTTPS_PORT,
  ARTIFACT_PORT,
  TERMINAL_HTTPS_PORT,
  TERMINAL_PORT,
  funnelStopArgs,
  inspectPreflight,
  newSecret,
  newSessionId,
  readJson,
  remoteTestsRoot,
  routeOwnedBy,
  runCommand
} from '../server/remote-test-core.mjs';

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

async function hidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('start requires an interactive terminal for the hidden passcode prompt');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return await new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (character) => {
      if (character === '\u0003') {
        cleanup();
        reject(new Error('cancelled'));
      } else if (character === '\r' || character === '\n') {
        cleanup();
        resolve(value);
      } else if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
      } else if (character >= ' ') {
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
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

async function start() {
  const current = await status();
  if (current.status === 'running') {
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
  const passcode = await hidden('Session passcode: ');
  if (passcode.length < 10) throw new Error('passcode must be at least 10 characters');
  const confirmation = await hidden('Confirm passcode: ');
  if (passcode !== confirmation) throw new Error('passcodes do not match');

  const id = newSessionId();
  const sessionPath = newSecret(24);
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
    expose: true
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
    child.send({ type: 'passcode', passcode });
  });
  if (child.connected) child.disconnect();
  child.unref();
  print({
    status: 'running',
    sessionId: id,
    pid: ready.pid,
    terminal: `https://${dnsName}${ready.basePath}/`,
    artifacts: `https://${dnsName}:${ARTIFACT_HTTPS_PORT}${ready.basePath}/`,
    note: 'Only artifacts that pass local verification are linked in the artifact pane.'
  });
}

async function stop() {
  const state = await readJson(stateFile);
  if (!state) {
    print({ status: 'stopped' });
    return;
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
  print({ status: 'stopped', sessionId: state.sessionId, preserved: state.sessionDir });
}

async function main() {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const command = process.argv[2] ?? 'status';
  if (command === 'start') return await start();
  if (command === 'status') return print(await status());
  if (command === 'stop') return await stop();
  if (command === 'preflight') {
    const report = await preflight();
    print(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === '--help' || command === 'help') {
    print('Usage: node scripts/hii-remote-test.mjs start|status|stop|preflight');
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`hii remote test: ${error.message}\n`);
  process.exitCode = 1;
});
