// SPDX-License-Identifier: LicenseRef-BSL-1.1

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const repo = path.resolve(process.cwd());
const port = Number(process.env.HII_WEB_DEV_RUNTIME_PORT || 3043);
const runs = new Map();

function hiiBinary() {
  const candidates = [
    process.env.HII_CLI_BIN,
    path.join(repo, 'target/debug/hii'),
    path.join(repo, 'target/release/hii')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'hii';
}

function headers(status = 200) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': `http://127.0.0.1:${port - 1}`,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store'
    }
  };
}

function send(response, value, status = 200) {
  const init = headers(status);
  response.writeHead(init.status, init.headers);
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error('development request exceeds 1 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(hiiBinary(), args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `hii exited ${code}`).trim()));
    });
  });
}

function startAgent(input) {
  const id = `web-${randomUUID()}`;
  const state = { version: 1, runId: id, status: 'started', text: '', receiptPath: undefined };
  runs.set(id, state);
  const args = [
    '--cwd', String(input.workspaceRoot || repo),
    'run', '--jsonl', '--stream', '--autonomy', 'local-full',
    String(input.intent || '')
  ];
  const child = spawn(hiiBinary(), args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '';
  const consume = (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const data = event.data || {};
        if (event.event === 'run.finished') {
          state.text = data.summary || state.text;
          state.receiptPath = data.proof;
        }
      } catch {
        // Raw CLI lines remain internal; the browser only receives normalized progress.
      }
    }
  };
  child.stdout.on('data', (chunk) => consume(String(chunk)));
  child.stderr.on('data', (chunk) => consume(String(chunk)));
  child.on('error', (error) => Object.assign(state, { status: 'failed', text: error.message }));
  child.on('close', (code) => {
    state.status = code === 0 ? 'completed' : 'failed';
    if (code !== 0 && !state.text) state.text = `HII stopped with exit ${code ?? 1}.`;
    state.finishedAt = new Date().toISOString();
  });
  return state;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return send(response, {});
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, { ok: true, binary: hiiBinary(), purpose: 'browser hot-reload transport only' });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/agent/')) {
      const run = runs.get(url.pathname.slice('/agent/'.length));
      return run ? send(response, run) : send(response, { error: 'run not found' }, 404);
    }
    if (request.method !== 'POST') return send(response, { error: 'not found' }, 404);
    const input = await body(request);
    if (url.pathname === '/agent') {
      if (!String(input.intent || '').trim()) return send(response, { error: 'intent is required' }, 400);
      return send(response, startAgent(input), 202);
    }
    if (url.pathname === '/information/capture') {
      const output = await cli(['--cwd', String(input.workspaceRoot || repo), 'info', 'capture', String(input.url || ''), '--json']);
      return send(response, JSON.parse(output));
    }
    if (url.pathname === '/information/find') {
      const args = ['info', 'find', String(input.query || ''), '--limit', String(input.limit || 10), '--json'];
      if (input.web) args.push('--web');
      const output = await cli(args);
      return send(response, JSON.parse(output));
    }
    return send(response, { error: 'not found' }, 404);
  } catch (error) {
    return send(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`HII browser-dev transport ready at http://127.0.0.1:${port} using ${hiiBinary()}\n`);
});
