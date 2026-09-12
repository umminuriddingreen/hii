#!/usr/bin/env node
// Smoke-test the real bare `hii` interactive entrypoint through a pseudo-TTY.
// This gives agents a deterministic way to prove startup without asking Ummi to
// paste terminal output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnPty } from 'node-pty';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.HII_CLI_BIN || path.join(root, 'target', 'release', 'hii');
const fakeModel = path.join(root, 'cli', 'tests', 'fixtures', 'fake_model.mjs');
const runtime = mkdtempSync(path.join(tmpdir(), 'hii-cli-interactive-'));
const realRuntime = process.argv.includes('--real');

if (!existsSync(binary)) {
  throw new Error(`missing HII CLI at ${binary}; run cargo build --release -p hii-cli`);
}

function waitFor(child, matcher, label, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${label}; output:\n${buffer.slice(-2000)}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      const match = matcher(buffer);
      if (match) {
        clearTimeout(timeout);
        resolve({ match, buffer });
      }
    });
    child.stderr?.on('data', (chunk) => {
      buffer += String(chunk);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`process exited before ${label}; code=${code}; output:\n${buffer.slice(-2000)}`));
    });
  });
}

let server;
let pty;
let ptyExited = false;
try {
  let port = null;
  if (!realRuntime) {
    server = spawn(process.execPath, [fakeModel, '--scenario', 'happy_calc', '--port', '0'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    const { match } = await waitFor(server, (text) => text.match(/PORT=(\d+)/), 'fake model port');
    port = match[1];
  }
  const output = [];
  let exitCode = null;
  let sentExit = false;
  const env = realRuntime ? process.env : {
    ...process.env,
    HII_RUNTIME_DIR: runtime,
    HII_MODEL_PROVIDER: 'ollama',
    HII_MODEL_URL: `http://127.0.0.1:${port}`,
    HII_MODEL: 'fake-model'
  };
  pty = spawnPty(binary, [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: realRuntime ? process.cwd() : root,
    env
  });
  pty.onData((data) => {
    output.push(data);
    const text = output.join('');
    if (/model '.+' is not installed/.test(text)) {
      pty.kill();
    }
    if (!sentExit && /\/exit|hii|HII|message|chat/i.test(text)) {
      sentExit = true;
      pty.write('/exit\r');
    }
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`bare hii did not exit cleanly; output:\n${output.join('').slice(-3000)}`));
    }, 12_000);
    pty.onExit(({ exitCode: code }) => {
      clearTimeout(timeout);
      ptyExited = true;
      exitCode = code;
      resolve(code);
    });
  });
  const transcript = output.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  assert.equal(result, 0, transcript);
  assert(!/model '.+' is not installed/.test(transcript), transcript);
  assert.match(transcript, /hii|HII|exit|message|chat/i);
  console.log('HII interactive CLI smoke');
  console.log('status:       ok');
  console.log(`binary:       ${binary}`);
  console.log('entrypoint:   bare hii');
  console.log(`runtime:      ${realRuntime ? 'real' : 'isolated fake model'}`);
  console.log(`model:        ${realRuntime ? 'real shell selection' : 'fake-model'}`);
  console.log(`exitCode:     ${exitCode}`);
} finally {
  if (pty && !ptyExited) pty.kill();
  if (server && !server.killed) server.kill('SIGTERM');
  rmSync(runtime, { recursive: true, force: true });
}
